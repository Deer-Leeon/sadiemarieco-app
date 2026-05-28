/**
 * GET /api/cron/cleanup-abandoned
 *
 * Vercel Cron entry point that runs every few minutes (see
 * `vercel.json`) to release Cal.com holds the client never finished
 * paying for. Without this, a visitor who opens the booking drawer,
 * picks a slot, then closes the tab before reaching /checkout would
 * leave Cal showing that time as "taken" forever — bricking the slot
 * for future visitors AND cluttering the studio's PENDING queue in
 * Cal's dashboard.
 *
 * Pipeline:
 *   1. CRON_SECRET gate via `lib/cron-auth.ts` (Bearer, X-Cron-Secret,
 *      or `?cron_secret=` — see that module for curl / redirect notes).
 *   2. SELECT all `appointments` rows with status='pending' older than
 *      the abandonment window (ABANDONMENT_MINUTES). Bound the result
 *      set so a one-off backlog can't blow up our request budget.
 *   3. For each row, POST Cal.com v2
 *      `/v2/bookings/<uid>/cancel` with Bearer auth and
 *      `{ cancellationReason: 'Checkout abandoned after 8 minutes.' }`.
 *      Frees the slot back into Cal's availability (v1 is decommissioned).
 *   4. Flip the local row to 'canceled_by_system' so the admin
 *      dashboard hides it from the calendar / list views (still
 *      visible in the client-profile history for drop-off analytics).
 *
 * Resilience:
 *   - One Cal failure does NOT abort the loop. We try every candidate,
 *     accumulate errors, and report counts in the response.
 *   - Cal-rejected → DB update happens regardless of Cal outcome IF the
 *     row is verifiably gone upstream (404). Otherwise we leave the
 *     status as 'pending' so the next sweep retries; chronically-
 *     failing rows surface as `errors` in the JSON response.
 *   - Status-update on Cal failure: we do NOT flip to canceled_by_system
 *     if Cal rejected our cancel for any reason other than 404, because
 *     the slot would then appear "free" in our DB but still "held" in
 *     Cal's calendar — exactly the bug this cron is meant to prevent.
 *
 * Why GET (not POST)?
 *   Vercel Cron only fires GET requests. The route is otherwise
 *   side-effecting, so the bearer-token gate is mandatory — without
 *   it any crawler hitting the URL could nuke pending bookings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import {
  CAL_ABANDON_CANCEL_REASON,
  CHECKOUT_HOLD_MINUTES,
} from '@/lib/booking-hold';
import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CAL_V2_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
const CAL_CANCEL_REASON = CAL_ABANDON_CANCEL_REASON;
// CHECKOUT_HOLD_MINUTES — long enough for a slow card fill-in (3DS, etc.)
// but short enough that an abandoned slot returns to availability quickly.
const ABANDONMENT_MINUTES = CHECKOUT_HOLD_MINUTES;
// Cap the work per cron tick so a backlog (cron paused for hours,
// many simultaneous drop-offs after a marketing push) can't pin a
// Vercel function on the request-budget ceiling. The next tick picks
// up whatever's left.
const MAX_SWEEP_BATCH = 50;

interface PendingRow {
  id: string;
  cal_event_id: string | null;
}

interface CalCancelOutcome {
  ok: boolean;
  /** True for HTTP 404 — booking already gone, treat as success. */
  alreadyGone: boolean;
  message: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cancel a single pending booking on Cal.com v2 so the slot returns
 * to availability. Same endpoint shape as `api/cancel-booking.js`.
 */
async function cancelOnCal(
  calBookingUid: string,
  apiKey: string
): Promise<CalCancelOutcome> {
  try {
    const upstream = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(calBookingUid)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ cancellationReason: CAL_CANCEL_REASON }),
      }
    );

    if (upstream.status === 404) {
      // Cal already lost track of this booking — perhaps the host
      // deleted it manually, or this is a re-run on a uid we already
      // released. Either way: the goal ("slot is no longer held
      // upstream") is met, so we treat it as success.
      return { ok: true, alreadyGone: true, message: null };
    }

    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => null);
      const message =
        (payload && typeof payload === 'object'
          ? ((payload as { message?: string; error?: string }).message ??
            (payload as { message?: string; error?: string }).error)
          : null) ?? `HTTP ${upstream.status}`;
      return { ok: false, alreadyGone: false, message };
    }

    return { ok: true, alreadyGone: false, message: null };
  } catch (err) {
    return { ok: false, alreadyGone: false, message: errorMessage(err) };
  }
}

interface ErrorEntry {
  appointmentId: string;
  calBookingUid: string | null;
  reason: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authFailure = rejectUnlessCronAuthorized(
    req,
    'api/cron/cleanup-abandoned'
  );
  if (authFailure) return authFailure;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error(
      '[api/cron/cleanup-abandoned] CAL_API_KEY not set — cannot release Cal holds'
    );
    return NextResponse.json(
      { error: 'cal_not_configured' },
      { status: 503 }
    );
  }

  // ── 1. FIND ABANDONED HOLDS ──────────────────────────────────────
  // `NOW() - INTERVAL 'N minutes'` keeps the cutoff math in the DB
  // so we don't fight JS/Postgres timezone drift. The interval is
  // string-interpolated through a template literal (not a parameter)
  // because @vercel/postgres binds parameters as text and Postgres'
  // INTERVAL syntax doesn't accept `$1 minutes`.
  let rows: PendingRow[];
  try {
    const result = await sql<PendingRow>`
      SELECT id, cal_event_id
      FROM appointments
      WHERE status = 'pending'
        AND created_at IS NOT NULL
        AND created_at < NOW() - (${ABANDONMENT_MINUTES} || ' minutes')::interval
      ORDER BY created_at ASC
      LIMIT ${MAX_SWEEP_BATCH}
    `;
    rows = result.rows;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/cron/cleanup-abandoned] db select failed:', msg);
    return NextResponse.json(
      { error: 'db_select_failed', message: msg },
      { status: 500 }
    );
  }

  if (rows.length === 0) {
    return NextResponse.json({
      success: true,
      releasedCount: 0,
      checkedCount: 0,
      errors: [],
    });
  }

  // ── 2. PROCESS EACH ABANDONED ROW ────────────────────────────────
  let releasedCount = 0;
  const errors: ErrorEntry[] = [];

  for (const row of rows) {
    // Rows without a Cal booking uid can still be flipped locally —
    // there's nothing to reject upstream, so the "slot is free" goal
    // is trivially met. Log because this shouldn't happen in normal
    // operation (the webhook writes uid before status hits pending).
    if (!row.cal_event_id) {
      console.warn(
        '[api/cron/cleanup-abandoned] pending row has no cal_event_id — local flip only',
        { appointmentId: row.id }
      );
      const flipped = await flipLocalStatus(row.id);
      if (flipped) {
        releasedCount += 1;
      } else {
        errors.push({
          appointmentId: row.id,
          calBookingUid: null,
          reason: 'db_update_failed_or_status_changed',
        });
      }
      continue;
    }

    const outcome = await cancelOnCal(row.cal_event_id, apiKey);
    if (!outcome.ok) {
      console.error(
        '[api/cron/cleanup-abandoned] Cal cancel failed — leaving row as pending for next sweep',
        {
          appointmentId: row.id,
          calBookingUid: row.cal_event_id,
          reason: outcome.message,
        }
      );
      errors.push({
        appointmentId: row.id,
        calBookingUid: row.cal_event_id,
        reason: outcome.message ?? 'cal_cancel_failed',
      });
      continue;
    }

    const flipped = await flipLocalStatus(row.id);
    if (flipped) {
      releasedCount += 1;
    } else {
      // Cal accepted the cancel but our DB UPDATE didn't move a row.
      // Most likely cause: the row's status changed between SELECT and
      // UPDATE (e.g. admin manually cancelled it, or /api/booking/confirm
      // raced us and promoted it to 'confirmed'). Either way, log and
      // don't double-count — the slot is released upstream regardless.
      console.warn(
        '[api/cron/cleanup-abandoned] Cal cancelled but local row no longer pending — skipping count',
        {
          appointmentId: row.id,
          calBookingUid: row.cal_event_id,
          alreadyGone: outcome.alreadyGone,
        }
      );
      errors.push({
        appointmentId: row.id,
        calBookingUid: row.cal_event_id,
        reason: 'db_status_drifted',
      });
    }
  }

  console.log('[api/cron/cleanup-abandoned] sweep complete', {
    checkedCount: rows.length,
    releasedCount,
    errorCount: errors.length,
  });

  return NextResponse.json({
    success: true,
    releasedCount,
    checkedCount: rows.length,
    errors,
  });
}

/**
 * Move a single row from 'pending' to 'canceled_by_system'. The WHERE
 * clause re-checks the status so we can't accidentally clobber a row
 * that was promoted to 'confirmed' between SELECT and UPDATE (race
 * with /api/booking/confirm). Returns true iff exactly one row moved.
 */
async function flipLocalStatus(appointmentId: string): Promise<boolean> {
  try {
    const { rowCount } = await sql`
      UPDATE appointments
      SET status = 'canceled_by_system'
      WHERE id = ${appointmentId}::uuid
        AND status = 'pending'
    `;
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error(
      '[api/cron/cleanup-abandoned] local status flip failed',
      { appointmentId, error: errorMessage(err) }
    );
    return false;
  }
}

