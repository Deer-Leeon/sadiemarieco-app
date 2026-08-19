/**
 * Release a single abandoned checkout hold: cancel on Cal.com (if needed)
 * and flip the local appointments row from `pending` → `canceled_by_system`.
 *
 * Used by the QStash delayed release webhook (`/api/qstash/release-hold`).
 * Idempotent: if the row is no longer pending (confirmed, already canceled,
 * etc.) this is a no-op success.
 */

import { sql } from '@vercel/postgres';

import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
  trackBookingEvent,
} from '@/lib/booking-analytics';
import { CAL_ABANDON_CANCEL_REASON } from '@/lib/booking-hold';
import { notifyCheckoutAbandonedSms } from '@/lib/booking-notifications';

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
  client_phone: string | null;
  service_name: string | null;
  booking_time: Date | string | null;
  sms_opt_in: boolean | null;
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

async function maybeNotifyAbandonedCheckout(
  row: AppointmentHoldRow,
  sendAbandonedSms: boolean
): Promise<void> {
  if (!sendAbandonedSms) return;
  if (row.sms_opt_in !== true) return;
  if (!row.client_phone) return;
  const bookingTime =
    row.booking_time instanceof Date
      ? row.booking_time.toISOString()
      : row.booking_time
        ? String(row.booking_time)
        : null;
  try {
    await notifyCheckoutAbandonedSms({
      clientPhone: row.client_phone,
      smsOptIn: row.sms_opt_in,
      serviceName: row.service_name,
      bookingTime,
      bookingUid: row.cal_event_id,
    });
  } catch (err) {
    console.warn('[release-abandoned-hold] abandoned SMS failed (non-fatal)', {
      appointmentId: row.id,
      error: errorMessage(err),
    });
  }
}

export interface ReleaseAbandonedHoldOptions {
  /**
   * When false, flip/cancel without the checkout-abandoned SMS.
   * Used for phone-booker init rollbacks (not a real abandon).
   * Default true.
   */
  sendAbandonedSms?: boolean;
}

/**
 * Look up by Cal booking UID (preferred) and release if still pending.
 */
export async function releaseAbandonedHoldByCalUid(
  calBookingUid: string,
  options?: ReleaseAbandonedHoldOptions
): Promise<ReleaseAbandonedHoldResult> {
  const uid = typeof calBookingUid === 'string' ? calBookingUid.trim() : '';
  if (!uid) {
    return { ok: true, released: false, skipped: 'missing_cal_booking_uid' };
  }

  let row: AppointmentHoldRow | undefined;
  try {
    const { rows } = await sql<AppointmentHoldRow>`
      SELECT id, cal_event_id, status, client_phone, service_name,
             booking_time, sms_opt_in
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

  return releasePendingRow(row, options);
}

async function releasePendingRow(
  row: AppointmentHoldRow,
  options?: ReleaseAbandonedHoldOptions
): Promise<ReleaseAbandonedHoldResult> {
  const sendAbandonedSms = options?.sendAbandonedSms !== false;
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
      await maybeNotifyAbandonedCheckout(row, sendAbandonedSms);
      if (sendAbandonedSms) {
        await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.HOLD_ABANDONED, {
          service: analyticsServiceLabel(row.service_name),
          source: 'no_cal_uid',
        });
      }
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

  // Flip the LOCAL row first. The pending-only UPDATE is the atomic arbiter
  // of the race against /api/booking/confirm (whose promote is also
  // pending-only): exactly one side wins. Cancelling on Cal before winning
  // this flip could cancel a booking the client just paid for.
  const flipped = await flipLocalStatus(row.id);
  if (!flipped) {
    console.warn(
      '[release-abandoned-hold] row no longer pending — confirm raced us, Cal left untouched',
      { appointmentId: row.id, calBookingUid: row.cal_event_id }
    );
    return {
      ok: true,
      released: false,
      skipped: 'db_status_drifted',
      appointmentId: row.id,
    };
  }

  let outcome = await cancelOnCal(row.cal_event_id, apiKey!);
  if (!outcome.ok) {
    // One inline retry — the local row is already released, so a QStash-level
    // retry would see non-pending and skip without ever reaching Cal.
    outcome = await cancelOnCal(row.cal_event_id, apiKey!);
  }
  if (!outcome.ok) {
    console.error(
      '[release-abandoned-hold] Cal cancel FAILED after local release — the Cal booking still blocks the slot; cancel it manually',
      {
        appointmentId: row.id,
        calBookingUid: row.cal_event_id,
        reason: outcome.message,
      }
    );
  }

  await maybeNotifyAbandonedCheckout(row, sendAbandonedSms);
  if (sendAbandonedSms) {
    await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.HOLD_ABANDONED, {
      service: analyticsServiceLabel(row.service_name),
      source: 'cal_cancel',
    });
  }
  return {
    ok: true,
    released: true,
    appointmentId: row.id,
    calBookingUid: row.cal_event_id,
  };
}
