/**
 * Release a single abandoned checkout hold: cancel on Cal.com (if needed)
 * and flip the local appointments row from `pending` → `canceled_by_system`.
 *
 * Used by the QStash delayed release webhook (`/api/qstash/release-hold`).
 * Idempotent: if the row is no longer pending (confirmed, already canceled,
 * etc.) this is a no-op success.
 */

import { sql } from '@vercel/postgres';

import { CAL_ABANDON_CANCEL_REASON } from '@/lib/booking-hold';

const CAL_V2_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

export type ReleaseAbandonedHoldResult =
  | { ok: true; released: true; appointmentId: string; calBookingUid: string | null }
  | { ok: true; released: false; skipped: string; appointmentId?: string }
  | { ok: false; retryable: boolean; reason: string; appointmentId?: string };

interface AppointmentHoldRow {
  id: string;
  cal_event_id: string | null;
  status: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CalCancelOutcome {
  ok: boolean;
  alreadyGone: boolean;
  message: string | null;
}

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
        body: JSON.stringify({ cancellationReason: CAL_ABANDON_CANCEL_REASON }),
      }
    );

    if (upstream.status === 404) {
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
    console.error('[release-abandoned-hold] local status flip failed', {
      appointmentId,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Look up by Cal booking UID (preferred) and release if still pending.
 */
export async function releaseAbandonedHoldByCalUid(
  calBookingUid: string
): Promise<ReleaseAbandonedHoldResult> {
  const uid = typeof calBookingUid === 'string' ? calBookingUid.trim() : '';
  if (!uid) {
    return { ok: true, released: false, skipped: 'missing_cal_booking_uid' };
  }

  let row: AppointmentHoldRow | undefined;
  try {
    const { rows } = await sql<AppointmentHoldRow>`
      SELECT id, cal_event_id, status
      FROM appointments
      WHERE cal_event_id = ${uid}
      LIMIT 1
    `;
    row = rows[0];
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      reason: `db_lookup_failed: ${errorMessage(err)}`,
    };
  }

  if (!row) {
    return { ok: true, released: false, skipped: 'appointment_not_found' };
  }

  return releasePendingRow(row);
}

async function releasePendingRow(
  row: AppointmentHoldRow
): Promise<ReleaseAbandonedHoldResult> {
  const status = (row.status || '').toLowerCase();
  if (status !== 'pending') {
    return {
      ok: true,
      released: false,
      skipped: `status_${status || 'unknown'}`,
      appointmentId: row.id,
    };
  }

  const apiKey = process.env.CAL_API_KEY?.trim();
  if (!apiKey && row.cal_event_id) {
    return {
      ok: false,
      retryable: false,
      reason: 'cal_not_configured',
      appointmentId: row.id,
    };
  }

  if (!row.cal_event_id) {
    console.warn(
      '[release-abandoned-hold] pending row has no cal_event_id — local flip only',
      { appointmentId: row.id }
    );
    const flipped = await flipLocalStatus(row.id);
    if (flipped) {
      return {
        ok: true,
        released: true,
        appointmentId: row.id,
        calBookingUid: null,
      };
    }
    return {
      ok: true,
      released: false,
      skipped: 'db_update_failed_or_status_changed',
      appointmentId: row.id,
    };
  }

  const outcome = await cancelOnCal(row.cal_event_id, apiKey!);
  if (!outcome.ok) {
    console.error(
      '[release-abandoned-hold] Cal cancel failed — leaving row as pending',
      {
        appointmentId: row.id,
        calBookingUid: row.cal_event_id,
        reason: outcome.message,
      }
    );
    return {
      ok: false,
      retryable: true,
      reason: outcome.message ?? 'cal_cancel_failed',
      appointmentId: row.id,
    };
  }

  const flipped = await flipLocalStatus(row.id);
  if (flipped) {
    return {
      ok: true,
      released: true,
      appointmentId: row.id,
      calBookingUid: row.cal_event_id,
    };
  }

  // Cal cancel succeeded but local row no longer pending (confirm raced us).
  console.warn(
    '[release-abandoned-hold] Cal cancelled but local row no longer pending',
    {
      appointmentId: row.id,
      calBookingUid: row.cal_event_id,
      alreadyGone: outcome.alreadyGone,
    }
  );
  return {
    ok: true,
    released: false,
    skipped: 'db_status_drifted',
    appointmentId: row.id,
  };
}
