/**
 * PATCH /api/admin/appointments/[id]/status
 *
 * Updates an appointment's lifecycle status from the admin dashboard.
 * Body: { status: AppointmentStatus }
 *
 * Behaviours per target status:
 *   • 'no-show'
 *       → charge 50% of the matched service price off-session against
 *         the vaulted card (`stripe_customer_id`), then flip local
 *         status. If Stripe declines, the row stays unchanged.
 *
 *   • 'confirmed' / 'canceled_by_client'
 *       → local DB update only. (canceled_by_client is unusual from
 *         the admin surface — it normally arrives via the webhook —
 *         but we accept it for completeness so the admin can also
 *         classify a phone-cancellation that didn't go through Cal.)
 *
 *   • 'canceled_by_admin'
 *       → call Cal.com's "Cancel a booking" endpoint with the row's
 *         cal_event_id (which holds Cal's booking UID, despite the
 *         column name — see `Appointment.cal_uid`). Cal cancels the
 *         calendar invite AND sends its native cancellation email to
 *         the client. THEN we flip our local status.
 *
 *         If the Cal call fails we still write the local status — the
 *         admin's intent is recorded, and the response carries a
 *         `cal_cancel_error` so the UI can surface a warning. If we
 *         refused to flip locally on Cal failure, the dashboard would
 *         silently leave the booking on the calendar despite the
 *         admin marking it cancelled, which is a worse outcome.
 *
 *         When Cal acks, it ALSO fires `BOOKING_CANCELLED` back to
 *         our webhook. That handler explicitly preserves
 *         'canceled_by_admin' (only overwrites 'confirmed' rows) so
 *         the late webhook can't clobber the more specific status
 *         we already set here.
 *
 * Authorisation: gated by `requireAdminUser` — same allowlist the
 * rest of the admin API uses.
 *
 * Row lookup mirrors the reschedule route: UUID first, legacy integer
 * second.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  APPOINTMENT_STATUSES,
  isAppointmentStatus,
  type AppointmentStatus,
} from '@/app/admin/types';
import { chargeNoShowPenalty } from '@/lib/no-show-charge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cal.com v2 cancel endpoint. v1 is deprecated (the rest of our
// codebase — services/sync, cancel-booking.js, booking.js — all use
// v2 with a Bearer token), so we stay on v2 for consistency. Same
// effect: the calendar invite is cancelled and Cal sends its native
// client-facing cancellation email.
const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
const ADMIN_CANCEL_REASON = 'Canceled by admin';

interface Context {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  status?: unknown;
}

interface AppointmentRow {
  id: string | number;
  cal_event_id: string | null;
  status: string | null;
}

interface AppointmentForNoShow {
  id: string | number;
  cal_event_id: string | null;
  status: string | null;
  stripe_customer_id: string | null;
  service_name: string | null;
  service_price: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseIntegerId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Cancel a booking upstream at Cal.com. Returns null on success, or
 * a human-readable error message on failure (which the caller folds
 * into the response so the UI can surface a non-blocking warning).
 *
 * Treats a 404 (booking already gone — duplicate cancel, manual
 * deletion in Cal's UI, etc.) as success: from the admin's
 * perspective the goal "this booking is no longer on the upstream
 * calendar" is already true.
 */
async function cancelOnCal(uid: string): Promise<string | null> {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error(
      '[api/admin/appointments/[id]/status] CAL_API_KEY missing — skipping upstream cancel'
    );
    return 'CAL_API_KEY not configured on the server';
  }

  try {
    const upstream = await fetch(
      `${CAL_API_BASE}/bookings/${encodeURIComponent(uid)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ cancellationReason: ADMIN_CANCEL_REASON }),
      }
    );

    if (upstream.status === 404) {
      console.warn(
        '[api/admin/appointments/[id]/status] cal returned 404 for cancel — treating as already cancelled',
        { uid }
      );
      return null;
    }

    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => null);
      const message =
        (payload && typeof payload === 'object'
          ? ((payload as { message?: string; error?: string }).message ??
            (payload as { message?: string; error?: string }).error)
          : null) ?? `HTTP ${upstream.status}`;
      console.error(
        '[api/admin/appointments/[id]/status] cal cancel failed',
        { uid, status: upstream.status, message }
      );
      return `Cal.com rejected the cancel (${message})`;
    }

    return null;
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      '[api/admin/appointments/[id]/status] cal cancel network error',
      { uid, error: msg }
    );
    return `Could not reach Cal.com (${msg})`;
  }
}

/**
 * UPDATE one appointment row by id. Tries UUID then legacy integer.
 * Returns the updated row, or null if no row was found.
 */
async function updateAppointmentStatus(
  idParam: string,
  status: AppointmentStatus
): Promise<AppointmentRow | null> {
  if (UUID_RE.test(idParam)) {
    const { rows } = await sql<AppointmentRow>`
      UPDATE appointments
      SET status = ${status}
      WHERE id = ${idParam}::uuid
      RETURNING id, cal_event_id, status
    `;
    return rows[0] ?? null;
  }
  const intId = parseIntegerId(idParam);
  if (intId !== null) {
    const { rows } = await sql<AppointmentRow>`
      UPDATE appointments
      SET status = ${status}
      WHERE id = ${intId}
      RETURNING id, cal_event_id, status
    `;
    return rows[0] ?? null;
  }
  return null;
}

/**
 * SELECT cal_event_id for a row by id — used before the status
 * update when the target status is `canceled_by_admin` so we can
 * call Cal first and surface upstream errors before mutating local
 * state. Separate from `updateAppointmentStatus` because we need
 * the UID BEFORE the write, not after.
 */
async function findAppointmentForNoShow(
  idParam: string
): Promise<AppointmentForNoShow | null> {
  if (UUID_RE.test(idParam)) {
    const { rows } = await sql<AppointmentForNoShow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.status,
        a.stripe_customer_id,
        a.service_name,
        s.price AS service_price
      FROM appointments a
      LEFT JOIN LATERAL (
        SELECT s.price
        FROM site_services s
        WHERE s.title = split_part(a.service_name, ' between ', 1)
          AND s.is_active = TRUE
          AND (
            lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
              'classic', 'hybrid', 'volume'
            )
            OR (
              a.booking_time IS NOT NULL
              AND a.end_time IS NOT NULL
              AND s.duration_mins IS NOT NULL
              AND s.duration_mins = GREATEST(
                1,
                ROUND(
                  EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                )
              )::integer
            )
          )
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE a.id = ${idParam}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  const intId = parseIntegerId(idParam);
  if (intId !== null) {
    const { rows } = await sql<AppointmentForNoShow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.status,
        a.stripe_customer_id,
        a.service_name,
        s.price AS service_price
      FROM appointments a
      LEFT JOIN LATERAL (
        SELECT s.price
        FROM site_services s
        WHERE s.title = split_part(a.service_name, ' between ', 1)
          AND s.is_active = TRUE
          AND (
            lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
              'classic', 'hybrid', 'volume'
            )
            OR (
              a.booking_time IS NOT NULL
              AND a.end_time IS NOT NULL
              AND s.duration_mins IS NOT NULL
              AND s.duration_mins = GREATEST(
                1,
                ROUND(
                  EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                )
              )::integer
            )
          )
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE a.id = ${intId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

async function findAppointmentCalUid(
  idParam: string
): Promise<{ id: string | number; cal_event_id: string | null } | null> {
  if (UUID_RE.test(idParam)) {
    const { rows } = await sql<{ id: string; cal_event_id: string | null }>`
      SELECT id, cal_event_id
      FROM appointments
      WHERE id = ${idParam}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  const intId = parseIntegerId(idParam);
  if (intId !== null) {
    const { rows } = await sql<{ id: number; cal_event_id: string | null }>`
      SELECT id, cal_event_id
      FROM appointments
      WHERE id = ${intId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id: idParam } = await params;
  if (!UUID_RE.test(idParam) && parseIntegerId(idParam) === null) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // ── Parse + validate body ─────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const body = raw as PatchBody;
  if (!isAppointmentStatus(body.status)) {
    return NextResponse.json(
      {
        error: 'invalid_status',
        accepted: APPOINTMENT_STATUSES,
      },
      { status: 400 }
    );
  }
  const targetStatus: AppointmentStatus = body.status;

  try {
    let calCancelError: string | null = null;
    let noShowCharge:
      | {
          payment_intent_id: string;
          amount_cents: number;
          currency: string;
        }
      | null = null;

    if (targetStatus === 'no-show') {
      const existing = await findAppointmentForNoShow(idParam);
      if (existing === null) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      if ((existing.status || '').toLowerCase() === 'no-show') {
        return NextResponse.json(
          {
            error: 'already_no_show',
            message: 'This appointment is already marked as a no-show.',
          },
          { status: 409 }
        );
      }

      if (!existing.stripe_customer_id) {
        return NextResponse.json(
          {
            error: 'no_vaulted_card',
            message:
              'No card on file for this client. They must complete checkout before a no-show fee can be charged.',
          },
          { status: 400 }
        );
      }

      const priceRaw =
        existing.service_price === null
          ? NaN
          : Number(existing.service_price);
      const serviceLabel =
        (existing.service_name || 'appointment').split(' between ')[0]?.trim() ||
        'appointment';

      const chargeResult = await chargeNoShowPenalty({
        stripeCustomerId: existing.stripe_customer_id,
        servicePriceDollars: priceRaw,
        appointmentId: String(existing.id),
        calBookingUid: existing.cal_event_id,
        serviceLabel,
      });

      if (!('paymentIntentId' in chargeResult)) {
        return NextResponse.json(
          {
            error: chargeResult.error,
            message: chargeResult.message,
          },
          { status: chargeResult.status }
        );
      }

      noShowCharge = {
        payment_intent_id: chargeResult.paymentIntentId,
        amount_cents: chargeResult.amountCents,
        currency: chargeResult.currency,
      };
    }

    // ── Admin-cancel branch: hit Cal first ────────────────────────
    // We deliberately ignore the existing local status here — if the
    // admin clicks "Cancel" again on an already-no-show row they
    // probably want it gone from the calendar AND off Cal too. The
    // Cal endpoint is idempotent (a 404 = already cancelled and we
    // treat that as success).
    if (targetStatus === 'canceled_by_admin') {
      const existing = await findAppointmentCalUid(idParam);
      if (existing === null) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      if (existing.cal_event_id) {
        calCancelError = await cancelOnCal(existing.cal_event_id);
      } else {
        // Legacy row with no Cal UID — nothing to cancel upstream.
        // The local status flip below is still the right thing to do.
        console.warn(
          '[api/admin/appointments/[id]/status] cancel requested on row with no cal_event_id — local-only flip',
          { id: existing.id }
        );
      }
    }

    // ── Local status write ────────────────────────────────────────
    const updated = await updateAppointmentStatus(idParam, targetStatus);
    if (updated === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({
      appointment: {
        id: updated.id,
        cal_uid: updated.cal_event_id,
        status: updated.status,
      },
      // Null on the happy path; populated when Cal's cancel call
      // failed but we still wrote the local status. The UI can
      // toast this so the admin knows the upstream calendar might
      // still show the booking.
      cal_cancel_error: calCancelError,
      no_show_charge: noShowCharge,
    });
  } catch (err) {
    const msg = errorMessage(err);
    // Surface the CHECK violation as a 400 so an invalid status value
    // that somehow got past the runtime validator (shouldn't happen,
    // but defence-in-depth) returns a clear error rather than a 500.
    if (msg.includes('check_status')) {
      return NextResponse.json(
        { error: 'invalid_status', message: msg },
        { status: 400 }
      );
    }
    console.error(
      '[api/admin/appointments/[id]/status] PATCH failed:',
      msg
    );
    return NextResponse.json(
      { error: 'db_update_failed', message: msg },
      { status: 500 }
    );
  }
}
