/**
 * Off-session $20 late-cancellation fee (within 24h of appointment start).
 *
 * Used by `api/webhook.js` on client-initiated BOOKING_CANCELLED events.
 * CommonJS so legacy Vercel serverless handlers can require it without TS.
 */

const Stripe = require('stripe');

/** Must match `ADMIN_CANCEL_REASON` in `app/api/admin/appointments/[id]/status/route.ts`. */
const ADMIN_CANCEL_REASON = 'Canceled by admin';

const LATE_CANCEL_FEE_CENTS = 2000;
const LATE_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const STRIPE_CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

/**
 * True when the cancellation happens in (0, 24h) before `bookingTime`.
 */
function isLateCancellationWindow(bookingTime) {
  if (!bookingTime) return false;
  const startMs = new Date(bookingTime).getTime();
  if (!Number.isFinite(startMs)) return false;
  const msUntilStart = startMs - Date.now();
  return msUntilStart > 0 && msUntilStart < LATE_CANCEL_WINDOW_MS;
}

function isAdminCancellationReason(cancellationReason) {
  const trimmed =
    typeof cancellationReason === 'string' ? cancellationReason.trim() : '';
  return trimmed === ADMIN_CANCEL_REASON;
}

/**
 * Guardrails: never penalize admin/system cancellations or abandon sweeps.
 */
function shouldSkipLateCancelPenalty({
  existingStatus,
  cancellationReason,
  systemAbandon,
}) {
  if (systemAbandon) return true;
  if (isAdminCancellationReason(cancellationReason)) return true;
  const s = (existingStatus || '').toLowerCase();
  if (s === 'canceled_by_admin' || s === 'canceled_by_system') return true;
  if (s === 'canceled_by_client_late') return true;
  return false;
}

/**
 * Charge the flat late-cancel fee off-session. Never throws — callers
 * log `{ ok: false, ... }` and still flip status to `canceled_by_client`.
 */
async function chargeLateCancelFee(params) {
  const stripe = getStripe();
  if (!stripe) {
    return {
      ok: false,
      error: 'stripe_not_configured',
      message: 'Stripe is not configured on the server.',
    };
  }

  const customerId = params.stripeCustomerId;
  if (!customerId || !STRIPE_CUSTOMER_ID_RE.test(customerId)) {
    return {
      ok: false,
      error: 'invalid_stripe_customer_id',
      message: 'No valid vaulted card customer on this appointment.',
    };
  }

  try {
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });
    const paymentMethod = methods.data[0];
    if (!paymentMethod) {
      return {
        ok: false,
        error: 'no_payment_method',
        message: 'No card is saved on file for this client.',
      };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: LATE_CANCEL_FEE_CENTS,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      description: `Late cancellation fee — ${params.serviceLabel}`.slice(0, 500),
      metadata: {
        appointment_id: String(params.appointmentId),
        ...(params.calBookingUid
          ? { cal_booking_uid: params.calBookingUid }
          : {}),
        fee_type: 'late_cancel_penalty',
      },
    });

    if (paymentIntent.status !== 'succeeded') {
      return {
        ok: false,
        error: 'payment_not_completed',
        message: `The charge did not complete (status: ${paymentIntent.status}).`,
      };
    }

    return {
      ok: true,
      paymentIntentId: paymentIntent.id,
      amountCents: LATE_CANCEL_FEE_CENTS,
      currency: paymentIntent.currency || 'usd',
    };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      const decline =
        err.decline_code && err.decline_code !== 'generic_decline'
          ? `${err.message} (${err.decline_code})`
          : err.message;
      return {
        ok: false,
        error: 'card_declined',
        message: decline || 'The card was declined.',
      };
    }

    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      const code = err.code || '';
      if (
        code === 'authentication_required' ||
        (err.message && err.message.includes('authentication'))
      ) {
        return {
          ok: false,
          error: 'authentication_required',
          message:
            'This card requires additional authentication and cannot be charged off-session.',
        };
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[late-cancel-charge] Stripe charge failed', {
      appointmentId: params.appointmentId,
      error: message,
    });
    return {
      ok: false,
      error: 'stripe_charge_failed',
      message,
    };
  }
}

module.exports = {
  ADMIN_CANCEL_REASON,
  LATE_CANCEL_FEE_CENTS,
  LATE_CANCEL_WINDOW_MS,
  isLateCancellationWindow,
  isAdminCancellationReason,
  shouldSkipLateCancelPenalty,
  chargeLateCancelFee,
};
