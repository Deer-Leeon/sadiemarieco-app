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
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

export const dynamic = 'force-dynamic';

const CAL_API_BASE = 'https://api.cal.com/v2';

// The v2 event-types endpoints are versioned by date header. 2024-06-14
// is the schema we wrote against (lengthInMinutes, data.id response,
// etc.); pinning it means a future Cal-side rev won't silently change
// shapes underneath us.
const CAL_API_VERSION = '2024-06-14';

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

interface ServiceRow {
  id: number;
  cal_event_id: number;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from pg
  duration_mins: number;
  is_active: boolean;
  slug: string | null;
}

interface CreatePayload {
  title: string;
  description: string;
  length: number;
  price: number;
  category: string;
}

interface UpdatePayload extends CreatePayload {
  db_id: number;
  cal_event_id: number;
}

// ─── HANDLERS ──────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

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
        slug
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY category ASC, title ASC
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
  let calEventId: number;
  try {
    const result = await createCalEvent(apiKey, {
      title: payload.title,
      description: payload.description,
      lengthInMinutes: payload.length,
      slug,
    });
    calEventId = result.id;
  } catch (err) {
    console.error('[api/admin/services] POST: Cal.com create failed:', err);
    return NextResponse.json(
      { error: 'cal_create_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }

  // ── STEP 1b: PATCH our custom bookingFields onto the new event ─────────
  // splitName + required phone. We deliberately omit email from the
  // payload — touching email triggers `checkIsEmailUserAccessible`
  // which always fails on personal accounts (see comment above). By
  // not sending it, Cal preserves its default required-email field
  // and the PATCH succeeds.
  try {
    await callCal(`/event-types/${calEventId}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({ bookingFields: STUDIO_BOOKING_FIELDS }),
    });
    console.log(
      '[api/admin/services] POST: Cal event created + booking-fields PATCHed',
      { calEventId }
    );
  } catch (err) {
    // Non-fatal — the event exists and is bookable with Cal's default
    // fields. We log so the operator can investigate, but we don't
    // tear the create down: a half-rolled-back event is worse than a
    // working event with the wrong name field, since the local DB row
    // still needs to be written for the editor to see anything at all.
    console.warn(
      '[api/admin/services] POST: bookingFields PATCH failed (event still created with Cal defaults):',
      { calEventId, error: errorMessage(err) }
    );
  }

  // ── STEP 2: mirror into Postgres ────────────────────────────────────────
  // If this fails the Cal event is a ghost. We attempt a best-effort
  // delete on Cal.com so we don't leave a bookable service the studio
  // didn't intend to publish. Failure of the cleanup is logged but not
  // fatal — we still surface the DB error to the editor.
  try {
    const { rows } = await sql<ServiceRow>`
      INSERT INTO site_services (
        cal_event_id, category, title, description, price, duration_mins, slug
      ) VALUES (
        ${calEventId},
        ${payload.category},
        ${payload.title},
        ${payload.description},
        ${payload.price},
        ${payload.length},
        ${slug}
      )
      RETURNING
        id, cal_event_id, category, title, description, price,
        duration_mins, is_active, slug
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

  // ── STEP 1: update Cal.com ──────────────────────────────────────────────
  // We only send the fields Cal.com knows about (title, description,
  // lengthInMinutes). `price` and `category` are local-only and never
  // reach Cal. v2 renames `length` → `lengthInMinutes` at the wire.
  try {
    await callCal(`/event-types/${payload.cal_event_id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        lengthInMinutes: payload.length,
      }),
    });
  } catch (err) {
    console.error('[api/admin/services] PATCH: Cal.com update failed:', err);
    return NextResponse.json(
      { error: 'cal_update_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }

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
        duration_mins = ${payload.length}
      WHERE id = ${payload.db_id}
      RETURNING
        id, cal_event_id, category, title, description, price,
        duration_mins, is_active, slug
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
  let dbId: number | null = null;
  let calEventId: number | null = null;

  const url = new URL(req.url);
  const qsDbId = url.searchParams.get('db_id');
  const qsCalId = url.searchParams.get('cal_event_id');
  if (qsDbId) dbId = Number(qsDbId);
  if (qsCalId) calEventId = Number(qsCalId);

  if (dbId === null || Number.isNaN(dbId)) {
    try {
      const body = await req.json();
      if (typeof body?.db_id === 'number') dbId = body.db_id;
      if (typeof body?.cal_event_id === 'number') calEventId = body.cal_event_id;
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

  // If the client didn't tell us the Cal event id, look it up. Saves a
  // round-trip in the happy path but keeps the endpoint usable from
  // tools like cURL.
  if (calEventId === null || Number.isNaN(calEventId)) {
    try {
      const { rows } = await sql<{ cal_event_id: number }>`
        SELECT cal_event_id FROM site_services WHERE id = ${dbId}
      `;
      if (rows.length === 0) {
        return NextResponse.json(
          { error: 'not_found', message: `No service with id=${dbId}.` },
          { status: 404 }
        );
      }
      calEventId = rows[0].cal_event_id;
    } catch (err) {
      console.error('[api/admin/services] DELETE: db lookup failed:', err);
      return NextResponse.json(
        { error: 'db_query_failed', message: errorMessage(err) },
        { status: 500 }
      );
    }
  }

  // ── STEP 1: hide on Cal.com ─────────────────────────────────────────────
  // Soft delete: PATCH `{ hidden: true }` rather than DELETE. This keeps
  // booking history intact (existing bookings against the event still
  // resolve) but removes the event from the public booking grid.
  try {
    await callCal(`/event-types/${calEventId}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: true }),
    });
  } catch (err) {
    console.error('[api/admin/services] DELETE: Cal.com hide failed:', err);
    return NextResponse.json(
      { error: 'cal_hide_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }

  // ── STEP 2: flip is_active in Postgres ──────────────────────────────────
  try {
    const { rowCount } = await sql`
      UPDATE site_services SET is_active = FALSE WHERE id = ${dbId}
    `;
    if (rowCount === 0) {
      // Cal.com was already updated but our row vanished. Same handling
      // as the PATCH not_found case: surface clearly so the UI refetches.
      return NextResponse.json(
        { error: 'not_found', message: `No service with id=${dbId}.` },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, id: dbId });
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

/**
 * Thin wrapper around fetch for Cal.com v2.
 *
 * Reasons for the indirection:
 *   • Centralises the v2 auth + version headers (Bearer token,
 *     `cal-api-version`) so individual call sites don't drift.
 *   • Surfaces Cal.com error bodies verbatim in the thrown Error so the
 *     client gets actionable messages ("slug already exists", "invalid
 *     length", etc.) rather than a generic 502.
 *   • Returns parsed JSON when available, an empty object otherwise
 *     (Cal.com's PATCH/DELETE responses are sometimes 204 No Content).
 *
 * Error message extraction:
 *   v2 error bodies are nested under `error.message` (the new envelope
 *   shape: `{ status: 'error', error: { code, message } }`). v1 used a
 *   top-level `message`. We probe both so we surface the actually
 *   useful string from whichever shape Cal returns.
 */
async function callCal<T = unknown>(
  path: string,
  apiKey: string,
  init: RequestInit
): Promise<T> {
  const res = await fetch(`${CAL_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'cal-api-version': CAL_API_VERSION,
      ...(init.headers ?? {}),
    },
    // Cal.com responses shouldn't be cached by anything in the chain —
    // even a brief stale read could mislead the editor about whether
    // a write actually landed.
    cache: 'no-store',
  });

  // Read once. Some Cal endpoints return JSON, others plain text on
  // error — handle both gracefully.
  const raw = await res.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!res.ok) {
    const detail = extractCalErrorMessage(parsed) || res.statusText;
    throw new Error(`Cal.com ${res.status}: ${detail}`);
  }

  return (parsed ?? {}) as T;
}

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

/**
 * Pull the most useful human-readable string out of a Cal.com error
 * response. v2 nests under `error.message`; v1 used top-level
 * `message`; plain-text bodies are returned verbatim. Falls back to
 * the JSON-stringified payload (truncated) so we never lose context.
 */
function extractCalErrorMessage(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (!isRecord(parsed)) return '';
  const err = parsed.error;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  if (typeof parsed.message === 'string') return parsed.message;
  return JSON.stringify(parsed).slice(0, 300);
}

function parseCreatePayload(input: unknown): CreatePayload {
  if (!isRecord(input)) {
    throw new Error('Body must be a JSON object.');
  }
  return {
    title: validateString(input.title, 'title', { max: TITLE_MAX, min: 1 }),
    description: validateString(input.description ?? '', 'description', {
      max: DESCRIPTION_MAX,
      min: 0,
    }),
    length: validateInt(input.length, 'length', {
      min: LENGTH_MIN,
      max: LENGTH_MAX,
    }),
    price: validateNumber(input.price, 'price', { min: 0, max: PRICE_MAX }),
    category: validateString(input.category, 'category', {
      max: CATEGORY_MAX,
      min: 1,
    }),
  };
}

function parseUpdatePayload(input: unknown): UpdatePayload {
  if (!isRecord(input)) {
    throw new Error('Body must be a JSON object.');
  }
  const base = parseCreatePayload(input);
  return {
    ...base,
    db_id: validateInt(input.db_id, 'db_id', { min: 1, max: 2 ** 31 - 1 }),
    cal_event_id: validateInt(input.cal_event_id, 'cal_event_id', {
      min: 1,
      max: 2 ** 31 - 1,
    }),
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
