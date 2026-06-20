/**
 * /api/admin/services
 *
 * Single trusted choke-point for mutating the studio's service menu.
 * Every write goes to Cal.com FIRST and then mirrors into the local
 * `site_services` table — so the booking page on cal.com/sadiemarie
 * never drifts from what /admin/services and the public site render.
 *
 * Why Cal-first instead of DB-first:
 *   The booking experience (where customers actually transact) is the
 *   source of truth that pays the studio's bills. If we can't persist
 *   to Cal.com — wrong API key, Cal.com outage, slug collision — we
 *   would rather show the editor an error and refuse to touch our
 *   local mirror than ship a state where customers see a service in
 *   our menu that Cal.com doesn't know how to book.
 *
 *   The reverse failure (Cal succeeds, our DB write fails) is mostly
 *   theoretical given Vercel Postgres availability, but we handle it
 *   anyway: POST attempts a best-effort delete of the Cal event we
 *   just created, so we don't leave a "ghost" event-type bookable on
 *   Cal but invisible in our own admin.
 *
 * Cal.com API surface used here (v2 — v1 was decommissioned May 2026):
 *   POST   https://api.cal.com/v2/event-types         create
 *   PATCH  https://api.cal.com/v2/event-types/{id}    update / hide
 *   DELETE https://api.cal.com/v2/event-types/{id}    hard delete
 *                                                     (orphan cleanup only)
 *
 * Cal.com v2 auth:
 *   • `Authorization: Bearer <CAL_API_KEY>`   (NOT `?apiKey=…` — that was v1)
 *   • `cal-api-version: 2024-06-14`           (mandatory; the docs warn that
 *                                              the endpoint silently
 *                                              defaults to an older shape
 *                                              when this header is missing)
 *
 * Response shape difference vs v1:
 *   v1 returned `{ event_type: { id, … } }` or the bare object.
 *   v2 returns `{ status: 'success', data: { id, … } }`. We read `data.id`.
 *
 * Field name difference vs v1:
 *   v1 used `length` (minutes). v2 uses `lengthInMinutes`. The local DB
 *   column and the JSON our client sends both still use `length` because
 *   that vocabulary predates v2 — we translate at the Cal boundary.
 *
 * Studio-policy fields applied to every bookable Cal event we create:
 *   • `afterEventBuffer` — from `CAL_AFTER_EVENT_BUFFER_MIN` in
 *     lib/cal-config.ts (0 = back-to-back slots).
 *   • `minimumBookingNotice` — from `CAL_MIN_BOOKING_NOTICE_MIN` in
 *     lib/cal-config.ts (30-minute lead time before any slot).
 *   • `slotInterval` — from `CAL_SLOT_INTERVAL_MIN` in lib/cal-config.ts
 *     (30-minute start-time grid regardless of service duration).
 *   • `hidden: true` — the cal.com/sadiemarie public profile is
 *     intentionally suppressed; this site's data-cal-link embeds are
 *     the canonical booking surface, and a second public menu on
 *     cal.com would drift the moment we add a service here that the
 *     homepage hasn't been re-deployed to render yet.
 *   • `confirmationPolicy: { disabled: true }` — bookings confirm
 *     immediately (no Cal-side pending state).
 *   • `locations` — in-person at {@link STUDIO_IN_PERSON_ADDRESS}.
 *   • `bookingFields` — split name + required phone (via PATCH).
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  CAL_AFTER_EVENT_BUFFER_MIN,
  CAL_MIN_BOOKING_NOTICE_MIN,
  CAL_SLOT_INTERVAL_MIN,
} from '@/lib/cal-config';
import { buildStudioCalEventPatchBody } from '@/lib/cal-event-studio-defaults';
import {
  CalApiError,
  callCal,
  reconcileWithCal,
} from '@/app/admin/services/sync';

export const dynamic = 'force-dynamic';

// Validation bounds. Stricter than the DB constraints so a bad form
// submission gets a clean 400 instead of a 500 from a SQL CHECK or a
// 422 from Cal.com (whose error messages are not designed for studio
// staff to read).
const TITLE_MAX = 120;
const CATEGORY_MAX = 80;
const DESCRIPTION_MAX = 2000;
const LENGTH_MIN = 5;
const LENGTH_MAX = 600; // 10h ceiling — anything longer is almost certainly a typo
const PRICE_MAX = 100000;

/**
 * Every event-type we create is marked hidden on Cal.com itself.
 * Bookings happen exclusively through this site's data-cal-link
 * embeds (see public/js/main.js), so the cal.com/sadiemarie public
 * profile would only duplicate the menu — and worse, drift from it
 * the moment we add a service the homepage hasn't been re-deployed
 * to render yet. Hiding at create time guarantees a single
 * canonical booking surface (this site) for the studio's whole
 * catalogue.
 *
 * Note for the soft-delete path: DELETE still PATCHes `hidden: true`
 * on the way out, which is now a no-op on the wire but cheap and
 * keeps the handler robust if this default is ever flipped to
 * false. The local `is_active = FALSE` flip is what actually
 * removes the row from /admin/services and the public menu.
 */
const HIDDEN_ON_CAL_DEFAULT = true;

interface ServiceRow {
  id: number;
  cal_event_id: number | null;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from pg
  duration_mins: number | null;
  is_active: boolean;
  slug: string | null;
  is_group: boolean;
  parent_id: number | null;
  color: string | null;
  display_order: number;
}

/**
 * Canonical 7-char hex form: `#` + 6 hex digits, case-insensitive on
 * the wire (normalised to upper-case before insert so the DB row is
 * deterministic). Matches the DB CHECK in
 * `scripts/add_site_services_color.sql` exactly so a value that
 * passes here can never bounce off the constraint.
 */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

interface CreatePayload {
  title: string;
  description: string;
  /**
   * Duration in minutes. Required for bookable (non-group) services
   * because Cal.com needs `lengthInMinutes`; ignored for groups
   * (parents have no duration of their own). Validators below enforce
   * the conditional requirement so the editor sees a clean 400
   * instead of a Cal-side rejection.
   */
  length: number | null;
  price: number;
  category: string;
  /** True for accordion-header rows that don't sync to Cal.com. */
  is_group: boolean;
  /**
   * Optional nesting under a group header. Validated against the DB
   * so children can't reference non-existent or non-group parents,
   * or parents in a different category. Always null for groups
   * themselves (a group cannot have a parent — depth is capped at 1).
   */
  parent_id: number | null;
  /**
   * Editor-assigned hex colour, canonical `#RRGGBB`. Null = "no
   * override — use the auto-matcher". A malformed hex is rejected
   * with a 400 by the parser; an empty string from the form is
   * normalised to null so editors can "clear" a colour by deleting
   * the input contents.
   */
  color: string | null;
}

interface UpdatePayload extends CreatePayload {
  db_id: number;
  /**
   * Optional — only present when editing a bookable service. Groups
   * have no Cal event, so this is null/absent for those payloads.
   * Type kept as nullable rather than required to avoid the client
   * having to fabricate a sentinel when editing a group.
   */
  cal_event_id: number | null;
}

// ─── HANDLERS ──────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  // Reconcile orphans before we read the list. `force: true` bypasses
  // the public-facing TTL — when the editor refetches services they
  // expect "I deleted in Cal, refresh shows it" to be immediate, not
  // "within the next minute". See app/admin/services/sync.ts for the
  // full safeguard rationale.
  await reconcileWithCal({ force: true });

  try {
    // ORDER BY category first then title gives the UI a stable section
    // order without needing to re-sort client-side. `is_active = TRUE`
    // hides soft-deleted rows. The composite partial index defined in
    // scripts/migrate_services.sql makes this an index-only scan.
    const { rows } = await sql<ServiceRow>`
      SELECT
        id,
        cal_event_id,
        category,
        title,
        description,
        price,
        duration_mins,
        is_active,
        slug,
        is_group,
        parent_id,
        color,
        display_order
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC
    `;

    // NUMERIC columns come back as strings from node-postgres. Coerce to
    // Number at the API boundary so the client doesn't have to remember
    // to parse-and-format on every render.
    const services = rows.map((r) => ({
      ...r,
      price: Number(r.price),
    }));

    return NextResponse.json({ services });
  } catch (err) {
    console.error('[api/admin/services] GET db query failed:', err);
    return NextResponse.json(
      { error: 'db_query_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/admin/services] POST: CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 }
    );
  }

  let payload: CreatePayload;
  try {
    payload = parseCreatePayload(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_payload', message: errorMessage(err) },
      { status: 400 }
    );
  }

  // Cross-row validation must wait for the DB — pulled out of
  // parseCreatePayload so the parser stays a pure shape validator
  // (easy to unit-test) and the route handler owns the DB-touching
  // checks. Same pattern used in PATCH below.
  if (payload.parent_id !== null) {
    try {
      await validateParentReference(payload.parent_id, payload.category);
    } catch (err) {
      return NextResponse.json(
        { error: 'invalid_payload', message: errorMessage(err) },
        { status: 400 }
      );
    }
  }

  // ── GROUP BRANCH ────────────────────────────────────────────────────────
  // Group headers are CMS-only — they exist solely to render the
  // accordion shell on the homepage and never resolve to a bookable
  // Cal event. Skip every Cal.com round-trip and write a row whose
  // cal_event_id / slug / duration_mins are all NULL. The UNIQUE
  // constraint on cal_event_id permits this because Postgres treats
  // multiple NULLs as distinct.
  if (payload.is_group) {
    try {
      const { rows } = await sql<ServiceRow>`
        INSERT INTO site_services (
          cal_event_id, category, title, description, price,
          duration_mins, slug, is_group, parent_id, color, display_order
        ) VALUES (
          NULL,
          ${payload.category},
          ${payload.title},
          ${payload.description},
          ${payload.price},
          NULL,
          NULL,
          TRUE,
          NULL,
          ${payload.color},
          (SELECT COALESCE(MAX(display_order), -1) + 1 FROM site_services)
        )
        RETURNING
          id, cal_event_id, category, title, description, price,
          duration_mins, is_active, slug, is_group, parent_id, color,
          display_order
      `;
      const service = rows[0];
      console.log('[api/admin/services] POST: group created (no Cal sync)', {
        id: service.id,
        title: service.title,
      });
      return NextResponse.json({
        service: { ...service, price: Number(service.price) },
      });
    } catch (err) {
      console.error('[api/admin/services] POST: group insert failed:', err);
      return NextResponse.json(
        { error: 'db_insert_failed', message: errorMessage(err) },
        { status: 500 }
      );
    }
  }

  // ── BOOKABLE SERVICE BRANCH ─────────────────────────────────────────────

  // ── STEP 1: create on Cal.com ───────────────────────────────────────────
  // Cal-first. If this fails, we return early and never touch Postgres,
  // so the editor's "the menu is unchanged" mental model holds.
  //
  // We split the Cal-side write into POST-then-PATCH for two reasons:
  //
  //   (1) Cal's v2 POST silently drops custom bookingFields on
  //       personal accounts (empirically verified May 2026). The same
  //       payload sent via PATCH is applied correctly, so the only
  //       reliable way to get our splitName + required-phone config
  //       onto a brand-new event is to create it bare and immediately
  //       update its bookingFields.
  //
  //   (2) It keeps the "did anything change?" semantics clean: if the
  //       create works but the booking-fields PATCH fails, we still
  //       have a bookable event with Cal's defaults, and we surface a
  //       clear warning rather than rolling everything back. The
  //       editor never ends up in a half-state where the row exists
  //       locally but the menu on Cal looks wrong.
  //
  // What we do NOT attempt: `email.required: false`. Cal's API
  // enforces `checkIsEmailUserAccessible` on every booking-fields
  // shape that touches email on personal accounts (the validator is
  // bypassed only on organisation-team event types — see Cal issue
  // #25430 and the queued fix in PR #26316). Until that ships we
  // accept the default required-email behaviour and surface a Cal
  // dashboard deep-link in the admin UI so editors can toggle the
  // field optional by hand if they want.
  const slug = makeSlug(payload.title);
  // Narrowed by the `if (payload.is_group) return` early-exit above:
  // when the branch reaches here, is_group is false and the parser
  // guarantees `length` is a valid integer. The non-null assertion
  // documents that invariant for the type checker.
  const lengthInMinutes = payload.length!;
  let calEventId: number;
  try {
    const result = await createCalEvent(apiKey, {
      title: payload.title,
      description: payload.description,
      lengthInMinutes,
      slug,
      afterEventBuffer: CAL_AFTER_EVENT_BUFFER_MIN,
      minimumBookingNotice: CAL_MIN_BOOKING_NOTICE_MIN,
      slotInterval: CAL_SLOT_INTERVAL_MIN,
      // Hide from cal.com/sadiemarie; this site is the only booking surface.
      hidden: HIDDEN_ON_CAL_DEFAULT,
    });
    calEventId = result.id;
  } catch (err) {
    console.error('[api/admin/services] POST: Cal.com create failed:', err);
    return NextResponse.json(
      { error: 'cal_create_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }

  await patchStudioCalEventDefaultsOnCal(calEventId, apiKey, 'POST');

  // ── STEP 2: mirror into Postgres ────────────────────────────────────────
  // If this fails the Cal event is a ghost. We attempt a best-effort
  // delete on Cal.com so we don't leave a bookable service the studio
  // didn't intend to publish. Failure of the cleanup is logged but not
  // fatal — we still surface the DB error to the editor.
  try {
    const { rows } = await sql<ServiceRow>`
      INSERT INTO site_services (
        cal_event_id, category, title, description, price,
        duration_mins, slug, is_group, parent_id, color, display_order
      ) VALUES (
        ${calEventId},
        ${payload.category},
        ${payload.title},
        ${payload.description},
        ${payload.price},
        ${lengthInMinutes},
        ${slug},
        FALSE,
        ${payload.parent_id},
        ${payload.color},
        (SELECT COALESCE(MAX(display_order), -1) + 1 FROM site_services)
      )
      RETURNING
        id, cal_event_id, category, title, description, price,
        duration_mins, is_active, slug, is_group, parent_id, color,
        display_order
    `;
    const service = rows[0];
    return NextResponse.json({
      service: { ...service, price: Number(service.price) },
    });
  } catch (err) {
    console.error(
      '[api/admin/services] POST: db insert failed — attempting Cal rollback:',
      { calEventId, error: errorMessage(err) }
    );
    try {
      await callCal(`/event-types/${calEventId}`, apiKey, {
        method: 'DELETE',
      });
    } catch (cleanupErr) {
      console.error(
        '[api/admin/services] POST: Cal rollback also failed — orphan event:',
        { calEventId, error: errorMessage(cleanupErr) }
      );
    }
    return NextResponse.json(
      { error: 'db_insert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/admin/services] PATCH: CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 }
    );
  }

  let payload: UpdatePayload;
  try {
    payload = parseUpdatePayload(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_payload', message: errorMessage(err) },
      { status: 400 }
    );
  }

  // ── PRE-CHECK: fetch existing row ──────────────────────────────────────
  // Three things we can only learn from the DB:
  //   • Does the row still exist? (race with a concurrent delete.)
  //   • What's its current is_group state? We forbid toggling it on
  //     PATCH because that would require either creating or
  //     hard-deleting a Cal event mid-update, and the simpler
  //     "delete + recreate" UX gives the editor a clearer mental model.
  //   • Same-category constraint on parent_id needs the stored row's
  //     category as part of the check (the form might not even ship
  //     category if the editor only changed price).
  let existing: ServiceRow;
  try {
    const { rows } = await sql<ServiceRow>`
      SELECT id, cal_event_id, category, title, description, price,
             duration_mins, is_active, slug, is_group, parent_id, color
      FROM site_services
      WHERE id = ${payload.db_id}
    `;
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error: 'not_found',
          message: `No site_services row with id=${payload.db_id}.`,
        },
        { status: 404 }
      );
    }
    existing = rows[0];
  } catch (err) {
    console.error('[api/admin/services] PATCH: pre-check failed:', err);
    return NextResponse.json(
      { error: 'db_query_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  if (existing.is_group !== payload.is_group) {
    return NextResponse.json(
      {
        error: 'invalid_payload',
        message:
          'Cannot toggle is_group on an existing service — delete and re-create instead.',
      },
      { status: 400 }
    );
  }

  // Hierarchy cross-row check (skipped for self-parent — already
  // caught by the helper). We pass childOwnId so a parent_id pointing
  // at the row itself fails with a clear message.
  if (payload.parent_id !== null) {
    try {
      await validateParentReference(
        payload.parent_id,
        payload.category,
        payload.db_id
      );
    } catch (err) {
      return NextResponse.json(
        { error: 'invalid_payload', message: errorMessage(err) },
        { status: 400 }
      );
    }
  }

  // ── GROUP BRANCH (no Cal sync) ──────────────────────────────────────────
  if (payload.is_group) {
    try {
      const { rows } = await sql<ServiceRow>`
        UPDATE site_services SET
          category    = ${payload.category},
          title       = ${payload.title},
          description = ${payload.description},
          price       = ${payload.price},
          parent_id   = ${payload.parent_id},
          color       = ${payload.color}
        WHERE id = ${payload.db_id}
        RETURNING
          id, cal_event_id, category, title, description, price,
          duration_mins, is_active, slug, is_group, parent_id, color,
          display_order
      `;
      const service = rows[0];
      return NextResponse.json({
        service: { ...service, price: Number(service.price) },
      });
    } catch (err) {
      console.error('[api/admin/services] PATCH: group update failed:', err);
      return NextResponse.json(
        { error: 'db_update_failed', message: errorMessage(err) },
        { status: 500 }
      );
    }
  }

  // ── BOOKABLE SERVICE BRANCH ─────────────────────────────────────────────
  // Defensive: a bookable row in the DB must have a cal_event_id and
  // the incoming payload must include length. Both are guaranteed by
  // the parser when is_group=false, but we re-assert here so an
  // upstream client mistake throws a clean 400 instead of a runtime
  // null-deref in the SQL parameters.
  if (existing.cal_event_id === null || payload.cal_event_id === null) {
    return NextResponse.json(
      {
        error: 'invalid_payload',
        message: 'Bookable service is missing cal_event_id — was it created as a group?',
      },
      { status: 400 }
    );
  }
  const lengthInMinutes = payload.length!;

  // ── STEP 1: update Cal.com ──────────────────────────────────────────────
  // We only send the fields Cal.com knows about (title, description,
  // lengthInMinutes). `price`, `category`, and the hierarchy fields
  // are local-only and never reach Cal. v2 renames `length` →
  // `lengthInMinutes` at the wire.
  try {
    await callCal(`/event-types/${payload.cal_event_id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        lengthInMinutes,
        afterEventBuffer: CAL_AFTER_EVENT_BUFFER_MIN,
        slotInterval: CAL_SLOT_INTERVAL_MIN,
      }),
    });
  } catch (err) {
    console.error('[api/admin/services] PATCH: Cal.com update failed:', err);
    return NextResponse.json(
      { error: 'cal_update_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }

  await patchStudioCalEventDefaultsOnCal(payload.cal_event_id, apiKey, 'PATCH');

  // ── STEP 2: mirror into Postgres ────────────────────────────────────────
  // Trigger `site_services_touch_updated_at_trg` (defined in the
  // migration) bumps updated_at automatically — we don't list it here.
  try {
    const { rows } = await sql<ServiceRow>`
      UPDATE site_services SET
        category      = ${payload.category},
        title         = ${payload.title},
        description   = ${payload.description},
        price         = ${payload.price},
        duration_mins = ${lengthInMinutes},
        parent_id     = ${payload.parent_id},
        color         = ${payload.color}
      WHERE id = ${payload.db_id}
      RETURNING
        id, cal_event_id, category, title, description, price,
        duration_mins, is_active, slug, is_group, parent_id, color,
        display_order
    `;
    if (rows.length === 0) {
      // Cal.com was already updated but our row vanished — the editor
      // is operating on a stale list. Surface a clear 404 so the UI can
      // refetch instead of silently no-op'ing.
      return NextResponse.json(
        {
          error: 'not_found',
          message: `No site_services row with id=${payload.db_id}.`,
        },
        { status: 404 }
      );
    }
    const service = rows[0];
    return NextResponse.json({
      service: { ...service, price: Number(service.price) },
    });
  } catch (err) {
    console.error('[api/admin/services] PATCH: db update failed:', err);
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/admin/services] DELETE: CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 }
    );
  }

  // DELETE conventionally has no body, so we accept db_id either in the
  // query string (?db_id=…) or as a JSON body — whichever the client
  // finds most natural. The admin UI uses the query string form.
  //
  // cal_event_id from the query string is now treated as an
  // optimisation hint only — we always re-read the row from the DB to
  // discover is_group + the canonical cal_event_id. Groups don't have
  // a Cal event at all, so trusting a client-supplied cal_event_id
  // could direct us to hide an unrelated event.
  let dbId: number | null = null;

  const url = new URL(req.url);
  const qsDbId = url.searchParams.get('db_id');
  if (qsDbId) dbId = Number(qsDbId);

  if (dbId === null || Number.isNaN(dbId)) {
    try {
      const body = await req.json();
      if (typeof body?.db_id === 'number') dbId = body.db_id;
    } catch {
      // No body is fine — we'll error out on the dbId check below.
    }
  }

  if (dbId === null || Number.isNaN(dbId)) {
    return NextResponse.json(
      { error: 'invalid_payload', message: 'Missing or invalid `db_id`.' },
      { status: 400 }
    );
  }

  // ── LOOKUP: discover whether this is a group + collect children ────────
  // The single SELECT also doubles as a "row exists" check; if it
  // returns zero we 404 cleanly without touching Cal.
  let target: { cal_event_id: number | null; is_group: boolean };
  let childCalIds: number[] = [];
  try {
    const { rows } = await sql<{ cal_event_id: number | null; is_group: boolean }>`
      SELECT cal_event_id, is_group
      FROM site_services
      WHERE id = ${dbId}
    `;
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'not_found', message: `No service with id=${dbId}.` },
        { status: 404 }
      );
    }
    target = rows[0];

    // For groups, also gather every active child's cal_event_id so
    // step 1 below can hide each child on Cal. We filter is_active
    // here so an already-soft-deleted child doesn't get re-PATCHed.
    if (target.is_group) {
      const { rows: children } = await sql<{ cal_event_id: number | null }>`
        SELECT cal_event_id
        FROM site_services
        WHERE parent_id = ${dbId} AND is_active = TRUE
      `;
      childCalIds = children
        .map((c) => c.cal_event_id)
        .filter((v): v is number => typeof v === 'number');
    }
  } catch (err) {
    console.error('[api/admin/services] DELETE: db lookup failed:', err);
    return NextResponse.json(
      { error: 'db_query_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  // ── STEP 1: hide on Cal.com ─────────────────────────────────────────────
  // Soft delete: PATCH `{ hidden: true }` rather than DELETE. This keeps
  // booking history intact (existing bookings against the event still
  // resolve).
  //
  // Since HIDDEN_ON_CAL_DEFAULT was introduced (POST creates every
  // event already hidden), this PATCH is usually a no-op on the wire
  // — but we keep it for two reasons:
  //   1. Robustness if the default ever flips back to `hidden: false`.
  //   2. Cleanup for events created BEFORE that default existed: any
  //      legacy row whose Cal event-type is still visible gets quietly
  //      hidden during the soft-delete.
  // The bookable-via-direct-slug surface is what the public site uses
  // either way, so an editor who restores an "is_active=FALSE" row by
  // hand still has a working booking link.
  //
  // For groups we hide every child event sequentially. We deliberately
  // do NOT parallelise: Cal.com rate-limits per-key, and groups in
  // this studio carry at most a handful of children (3–5). If one
  // child fails we abort and don't soft-delete locally, so the editor
  // sees a clear error and the rest of the group stays intact for a
  // retry. The alternative ("partial hide + local delete") would leave
  // some children bookable on Cal but invisible in our admin.
  const calIdsToHide = target.is_group
    ? childCalIds
    : target.cal_event_id !== null
      ? [target.cal_event_id]
      : []; // standalone-group case is impossible per CREATE invariants

  // Tracks Cal event-types that were already gone when we tried to
  // hide them. We surface the count in the response so the UI can
  // optionally inform the editor that the row was auto-reconciled,
  // and so we have a structured signal in the logs.
  const calIdsAlreadyGone: number[] = [];

  for (const calId of calIdsToHide) {
    try {
      await callCal(`/event-types/${calId}`, apiKey, {
        method: 'PATCH',
        body: JSON.stringify({ hidden: true }),
      });
    } catch (err) {
      // 404 from Cal means the event-type was deleted directly in the
      // Cal dashboard (outside our admin UI). Our local row is the
      // orphan — the right move is to complete the local soft-delete
      // so the row stops appearing on /admin/services and the public
      // homepage. Without this, the orphan was effectively un-
      // deletable and stayed visible forever.
      if (err instanceof CalApiError && err.status === 404) {
        console.warn(
          '[api/admin/services] DELETE: Cal event already gone (404); treating as orphan and continuing',
          { calId }
        );
        calIdsAlreadyGone.push(calId);
        continue;
      }
      console.error('[api/admin/services] DELETE: Cal.com hide failed:', {
        calId,
        error: errorMessage(err),
      });
      return NextResponse.json(
        { error: 'cal_hide_failed', message: errorMessage(err) },
        { status: 502 }
      );
    }
  }

  // ── STEP 2: flip is_active in Postgres ──────────────────────────────────
  // For groups, the single UPDATE soft-deletes the group AND every
  // active child in one round-trip via the parent_id condition.
  // The CTE keeps both flips in a single transaction so a Postgres
  // failure mid-write doesn't leave half the children active.
  try {
    if (target.is_group) {
      const { rowCount } = await sql`
        UPDATE site_services
        SET is_active = FALSE
        WHERE id = ${dbId} OR parent_id = ${dbId}
      `;
      if (rowCount === 0) {
        return NextResponse.json(
          { error: 'not_found', message: `No service with id=${dbId}.` },
          { status: 404 }
        );
      }
      return NextResponse.json({
        ok: true,
        id: dbId,
        // rowCount is non-null here because the zero-row branch
        // returned above; subtracting 1 yields the count of child
        // rows that were soft-deleted alongside the parent group.
        children_removed: (rowCount ?? 1) - 1,
        cal_events_already_gone: calIdsAlreadyGone,
      });
    }

    const { rowCount } = await sql`
      UPDATE site_services SET is_active = FALSE WHERE id = ${dbId}
    `;
    if (rowCount === 0) {
      return NextResponse.json(
        { error: 'not_found', message: `No service with id=${dbId}.` },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ok: true,
      id: dbId,
      cal_events_already_gone: calIdsAlreadyGone,
    });
  } catch (err) {
    console.error('[api/admin/services] DELETE: db soft-delete failed:', err);
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Authenticates the caller and returns a NextResponse to short-circuit
 * the handler if the gate fails. Returns `null` on success so the
 * handler can keep going without an extra layer of nesting.
 */
async function gateAdmin(): Promise<NextResponse | null> {
  const access = await requireAdminUser();
  if (access.ok) return null;
  return NextResponse.json(
    { error: access.reason },
    { status: access.reason === 'unauthenticated' ? 401 : 403 }
  );
}

// `callCal` and `CalApiError` live in app/admin/services/sync.ts so
// the Server Components (page.tsx, app/route.ts) can share them.

/**
 * Wrapper for the v2 POST /event-types call. Lifts the response-shape
 * validation (Cal returns `{ status, data: { id } }` — we read data.id)
 * out of the hot path so the POST handler can read top-to-bottom and
 * the retry path can call this with a different `bookingFields` array
 * without duplicating the shape-validation logic.
 */
async function createCalEvent(
  apiKey: string,
  body: CalCreateEventBody
): Promise<{ id: number }> {
  const created = await callCal<{ status?: string; data?: { id: number } }>(
    `/event-types`,
    apiKey,
    { method: 'POST', body: JSON.stringify(body) }
  );
  const id = created.data?.id;
  if (typeof id !== 'number') {
    throw new Error(
      `Cal.com response missing numeric data.id; got: ${JSON.stringify(
        created
      ).slice(0, 200)}`
    );
  }
  return { id };
}

interface CalCreateEventBody {
  title: string;
  description: string;
  lengthInMinutes: number;
  slug: string;
  /** Cal v2 `afterEventBuffer` — see `CAL_AFTER_EVENT_BUFFER_MIN`. */
  afterEventBuffer: number;
  /** Cal v2 `minimumBookingNotice` — see `CAL_MIN_BOOKING_NOTICE_MIN`. */
  minimumBookingNotice: number;
  /** Cal v2 `slotInterval` — see `CAL_SLOT_INTERVAL_MIN`. */
  slotInterval: number;
  /**
   * If true, the event-type does not appear on the user's public
   * cal.com profile (cal.com/<username>). It remains bookable via its
   * direct slug URL and via embeds — which is exactly the surface this
   * site uses. Defaulting to true (HIDDEN_ON_CAL_DEFAULT) keeps the
   * Cal-side menu from drifting away from this homepage's rendering.
   */
  hidden: boolean;
}

/**
 * Discriminated union of the booking-field shapes we actually send.
 * Cal.com v2 accepts a much larger oneOf (address/text/number/etc.) —
 * we only enumerate the two this route uses so the TypeScript checker
 * catches a typo on a property name at build time rather than letting
 * Cal reject it at runtime.
 *
 * Shapes derived from the OpenAPI schema at
 * https://cal.com/docs/api-reference/v2/event-types/create-an-event-type
 * (specifically SplitNameDefaultFieldInput_2024_06_14 and
 * PhoneFieldInput_2024_06_14).
 *
 * Email is deliberately absent. Cal.com's API runs a
 * `checkIsEmailUserAccessible` guard on every booking-fields shape
 * that touches email on personal accounts (see Cal issue #25430).
 * Since we can only set email back to its default required+visible
 * state — which is what Cal already does when we omit the field —
 * there is no benefit to sending it. The "make email optional"
 * affordance lives in the Cal dashboard, deep-linked from each card
 * on /admin/services.
 */
type CalBookingField = CalSplitNameField | CalPhoneField;

interface CalSplitNameField {
  type: 'splitName';
  firstNameLabel: string;
  firstNamePlaceholder: string;
  lastNameLabel: string;
  lastNamePlaceholder: string;
  /**
   * From the v2 schema: "First name field is required but last name
   * field is not by default." So firstName is always required and we
   * only get to toggle lastName. true here = full split name required.
   */
  lastNameRequired: boolean;
}

interface CalPhoneField {
  type: 'phone';
  /**
   * The special slug `attendeePhoneNumber` is what would tell Cal
   * this phone field is the substitute identifier for phone-only
   * bookings (used in combination with email `{ required: false,
   * hidden: true }` for the org-team flow). We use the same slug on
   * personal accounts too — Cal accepts it as a regular unique
   * identifier when the phone-only flow isn't active, and using the
   * canonical slug means a future Cal-side migration to org-team
   * won't require changing the wire payload.
   */
  slug: string;
  label: string;
  required: boolean;
  placeholder: string;
  hidden: boolean;
}

/**
 * The studio's standard booking-fields config, applied via PATCH to
 * every new event. Constant rather than function because the shape
 * never depends on the inputs — every service collects the same name
 * (split into First + Last, both required) and the same phone
 * (required, visible) up front.
 */
/**
 * Apply studio defaults on Cal: booking fields, auto-confirm, in-person location.
 * Email is omitted from bookingFields (Cal personal accounts reject API email tweaks).
 */
async function patchStudioCalEventDefaultsOnCal(
  calEventId: number,
  apiKey: string,
  phase: 'POST' | 'PATCH'
): Promise<void> {
  try {
    await callCal(`/event-types/${calEventId}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify(
        buildStudioCalEventPatchBody(STUDIO_BOOKING_FIELDS)
      ),
    });
    console.log(`[api/admin/services] ${phase}: Cal studio defaults PATCHed`, {
      calEventId,
    });
  } catch (err) {
    console.warn(
      `[api/admin/services] ${phase}: Cal studio defaults PATCH failed (event still bookable with Cal defaults):`,
      { calEventId, error: errorMessage(err) }
    );
  }
}

const STUDIO_BOOKING_FIELDS: CalBookingField[] = [
  {
    type: 'splitName',
    firstNameLabel: 'First name',
    firstNamePlaceholder: 'First name',
    lastNameLabel: 'Last name',
    lastNamePlaceholder: 'Last name',
    lastNameRequired: true,
  },
  {
    type: 'phone',
    slug: 'attendeePhoneNumber',
    label: 'Phone number',
    required: true,
    placeholder: '+1 555 123 4567',
    hidden: false,
  },
];

function parseCreatePayload(input: unknown): CreatePayload {
  if (!isRecord(input)) {
    throw new Error('Body must be a JSON object.');
  }

  const is_group = validateBoolean(input.is_group ?? false, 'is_group');
  const parent_id = parseOptionalInt(input.parent_id, 'parent_id');

  // Hierarchy invariant: depth is capped at 1. Groups are top-level
  // accordion headers and can never themselves be children. Enforced
  // here so a malformed admin form never reaches the DB.
  if (is_group && parent_id !== null) {
    throw new Error('A group cannot have a parent_id (groups are top-level).');
  }

  // `length` is required for bookable services (Cal needs it) and
  // forbidden for groups (they're folders, not events). We coerce to
  // null in the group branch even if the client sent a value, so the
  // DB never carries a phantom duration on a header row.
  const length: number | null = is_group
    ? null
    : validateInt(input.length, 'length', {
        min: LENGTH_MIN,
        max: LENGTH_MAX,
      });

  return {
    title: validateString(input.title, 'title', { max: TITLE_MAX, min: 1 }),
    description: validateString(input.description ?? '', 'description', {
      max: DESCRIPTION_MAX,
      min: 0,
    }),
    length,
    price: validateNumber(input.price, 'price', { min: 0, max: PRICE_MAX }),
    category: validateString(input.category, 'category', {
      max: CATEGORY_MAX,
      min: 1,
    }),
    is_group,
    parent_id,
    color: parseOptionalColor(input.color, 'color'),
  };
}

/**
 * Coerce optional colour fields:
 *   • undefined / null / '' → null  (editor cleared the field)
 *   • '#rrggbb' / '#RRGGBB' → '#RRGGBB' (canonicalised to upper-case)
 *   • anything else         → throw  (UI rejects + DB CHECK would too)
 *
 * The upper-case normalisation matters because the YIQ contrast
 * computation in `app/admin/serviceColors.ts` is case-insensitive,
 * but the calendar's data-attributes and any future CSS selectors
 * benefit from a single deterministic spelling in the DB.
 */
function parseOptionalColor(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Field "${field}" must be a string or null.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new Error(
      `Field "${field}" must be a hex colour in the form "#RRGGBB" (got "${trimmed}").`
    );
  }
  return trimmed.toUpperCase();
}

function parseUpdatePayload(input: unknown): UpdatePayload {
  if (!isRecord(input)) {
    throw new Error('Body must be a JSON object.');
  }
  const base = parseCreatePayload(input);
  // `cal_event_id` is only meaningful for bookable services. Groups
  // never carry one, so we accept null/missing for them and require a
  // positive integer for everyone else. The PATCH handler still
  // cross-checks the value against the stored row, so a client that
  // omits cal_event_id while editing a bookable service will get a
  // clean 400 there rather than silently no-op the Cal sync.
  const cal_event_id = base.is_group
    ? null
    : validateInt(input.cal_event_id, 'cal_event_id', {
        min: 1,
        max: 2 ** 31 - 1,
      });
  return {
    ...base,
    db_id: validateInt(input.db_id, 'db_id', { min: 1, max: 2 ** 31 - 1 }),
    cal_event_id,
  };
}

function validateString(
  value: unknown,
  field: string,
  bounds: { min: number; max: number }
): string {
  if (typeof value !== 'string') {
    throw new Error(`Field "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < bounds.min) {
    throw new Error(
      `Field "${field}" must be at least ${bounds.min} character(s).`
    );
  }
  if (trimmed.length > bounds.max) {
    throw new Error(
      `Field "${field}" must be at most ${bounds.max} characters.`
    );
  }
  return trimmed;
}

function validateNumber(
  value: unknown,
  field: string,
  bounds: { min: number; max: number }
): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`Field "${field}" must be a finite number.`);
  }
  if (n < bounds.min || n > bounds.max) {
    throw new Error(
      `Field "${field}" must be between ${bounds.min} and ${bounds.max}.`
    );
  }
  return n;
}

function validateInt(
  value: unknown,
  field: string,
  bounds: { min: number; max: number }
): number {
  const n = validateNumber(value, field, bounds);
  if (!Number.isInteger(n)) {
    throw new Error(`Field "${field}" must be an integer.`);
  }
  return n;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  // Tolerate string forms — some form encodings deliver "true"/"false"
  // even when the client wanted a JSON bool. Anything else is a real
  // shape mismatch and worth a 400.
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Field "${field}" must be a boolean.`);
}

/**
 * Coerce optional integer fields ({null|undefined|missing} → null,
 * positive int → number, anything else → throw). Used for the
 * hierarchical `parent_id` field where "no parent" is a legitimate
 * value distinct from "validation error".
 */
function parseOptionalInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return validateInt(value, field, { min: 1, max: 2 ** 31 - 1 });
}

/**
 * Confirm that a `parent_id` references a row that:
 *   1. Exists and is active,
 *   2. Is itself a group (is_group = TRUE),
 *   3. Sits in the same category as the would-be child.
 *
 * All three rules together encode the visual invariant the public
 * site assumes: every accordion shelf renders inside a single
 * category column, and only group headers can host children. A
 * misconfigured pairing here would either orphan the child on the
 * homepage or create a confusing two-tier nesting we don't render.
 *
 * Throws a user-facing error string on any violation — the POST/PATCH
 * handlers surface it verbatim in the 400 response body.
 */
async function validateParentReference(
  parentId: number,
  childCategory: string,
  childOwnId: number | null = null
): Promise<void> {
  const { rows } = await sql<{
    id: number;
    is_group: boolean;
    category: string;
    is_active: boolean;
  }>`
    SELECT id, is_group, category, is_active
    FROM site_services
    WHERE id = ${parentId}
  `;
  if (rows.length === 0) {
    throw new Error(`Parent service id=${parentId} does not exist.`);
  }
  const parent = rows[0];
  if (!parent.is_active) {
    throw new Error(
      `Parent service id=${parentId} is inactive (soft-deleted).`
    );
  }
  if (!parent.is_group) {
    throw new Error(
      `Parent service id=${parentId} is not a group header — only groups can host children.`
    );
  }
  if (parent.category !== childCategory) {
    throw new Error(
      `Parent group sits in category "${parent.category}" but child is in "${childCategory}". Move them to the same category.`
    );
  }
  // Self-reference protection — only relevant on PATCH where the row
  // already exists in the DB.
  if (childOwnId !== null && childOwnId === parentId) {
    throw new Error('A service cannot be its own parent.');
  }
}

/**
 * Title → kebab-case slug + a 6-char base36 timestamp suffix. The
 * suffix is what keeps repeat titles ("Brow Lamination" added a second
 * time after the first was soft-deleted) from colliding with Cal.com's
 * unique-slug constraint on the account.
 *
 * Editors never see this string. Cal.com uses it internally and on the
 * booking URL (cal.com/sadiemarie/<slug>) — the suffix makes those URLs
 * slightly less pretty but every other tradeoff (failed creates, manual
 * slug input in the form, slug uniqueness collisions across re-creates)
 * was worse for the studio workflow.
 */
function makeSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = Date.now().toString(36).slice(-6);
  return base ? `${base}-${suffix}` : `service-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
