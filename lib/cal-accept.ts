/**
 * Accept a pending booking on Cal.com so it leaves "Unconfirmed".
 * Shared by POST /api/booking/confirm and the Stripe webhook payment
 * reconciliation (lib/booking-payment-recovery.ts).
 *
 * Returns null on success, or a human-readable error for the UI.
 *
 * When confirmation is disabled on the event type, Cal creates the
 * booking as already accepted — confirm/accept calls then fail with
 * a 400. We treat that as success (card vault + local DB are what
 * matter for checkout).
 *
 * Uses v2 confirm only — Cal decommissioned API v1 (HTTP 410,
 * May 2026), so the historical v1-PATCH-first strategy would just
 * burn a failed request on every booking.
 */

import {
  CAL_BOOKINGS_API_VERSION,
  calUpstreamErrorMessage,
  fetchCalBookingIsAccepted,
  isCalBookingAlreadyConfirmed,
} from '@/lib/cal-proxy';

const CAL_V2_BASE = 'https://api.cal.com/v2';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function treatConfirmFailureAsSuccessIfAccepted(
  calEventId: string,
  apiKey: string,
  payload: unknown,
  message: string
): Promise<boolean> {
  if (isCalBookingAlreadyConfirmed(payload, message)) {
    console.log(
      '[cal-accept] booking already confirmed on Cal — treating as success',
      { calEventId, message }
    );
    return true;
  }
  if (
    await fetchCalBookingIsAccepted(calEventId, apiKey, CAL_BOOKINGS_API_VERSION)
  ) {
    console.log(
      '[cal-accept] booking status is accepted on Cal — treating confirm as success',
      { calEventId }
    );
    return true;
  }
  return false;
}

export async function acceptOnCal(calEventId: string): Promise<string | null> {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[cal-accept] CAL_API_KEY not set — skipping Cal accept');
    return 'CAL_API_KEY not configured on the server';
  }

  // ── v2: POST /bookings/:uid/confirm (cancel-booking.js pattern) ───
  try {
    const v2 = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(calEventId)}/confirm`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_BOOKINGS_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    if (v2.ok) {
      console.log('[cal-accept] Cal v2 confirm succeeded', { calEventId });
      return null;
    }

    const v2Payload = await v2.json().catch(() => null);
    const v2Message = calUpstreamErrorMessage(v2Payload, v2.status);
    if (
      await treatConfirmFailureAsSuccessIfAccepted(
        calEventId,
        apiKey,
        v2Payload,
        v2Message
      )
    ) {
      return null;
    }
    console.error('[cal-accept] Cal v2 confirm failed', {
      calEventId,
      status: v2.status,
      message: v2Message,
    });
    return `Cal.com rejected the confirmation (${v2Message})`;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[cal-accept] Cal v2 confirm network error', {
      calEventId,
      error: msg,
    });
    return `Could not reach Cal.com (${msg})`;
  }
}
