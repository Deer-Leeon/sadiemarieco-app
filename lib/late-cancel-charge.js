/**
 * Off-session client cancel/reschedule penalties (policy-aligned):
 *   • 2h–24h before start → 50% of service price (late change)
 *   • under 2h before start → 100% (treated as no-show)
 *
 * Used by `api/webhook.js` on client-initiated BOOKING_CANCELLED and
 * BOOKING_RESCHEDULED events. CommonJS for legacy Vercel handlers.
 */

const Stripe = require('stripe');

/** Must match `ADMIN_CANCEL_REASON` in `app/api/admin/appointments/[id]/status/route.ts`. */
const ADMIN_CANCEL_REASON = 'Canceled by admin';

const LATE_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const NO_SHOW_CANCEL_WINDOW_MS = 2 * 60 * 60 * 1000;
const LATE_CANCEL_FRACTION = 0.5;
const NO_SHOW_CANCEL_FRACTION = 1;
const STRIPE_CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;

/** @deprecated Use LATE_CANCEL_FRACTION + penaltyAmountCents; kept for call-site greps. */
const LATE_CANCEL_FEE_CENTS = 2000;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

/**
 * Pure fee math — mirrors `lib/no-show-penalty.ts` for the CJS webhook path.
 * @param {number} servicePriceDollars
 * @param {number} fraction
 * @returns {number}
 */
function penaltyAmountCents(servicePriceDollars, fraction) {
  if (!Number.isFinite(servicePriceDollars) || servicePriceDollars <= 0) {
    return 0;
  }
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return 0;
  }
  return Math.round(servicePriceDollars * fraction * 100);
}

/**
 * @param {unknown} bookingTime
 * @returns {'none' | 'late_half' | 'no_show_full'}
 */
function classifyClientCancelPenalty(bookingTime) {
  if (!bookingTime) return 'none';
  const startMs = new Date(bookingTime).getTime();
  if (!Number.isFinite(startMs)) return 'none';
  const msUntilStart = startMs - Date.now();
  if (msUntilStart <= 0 || msUntilStart >= LATE_CANCEL_WINDOW_MS) {
    return 'none';
  }
  if (msUntilStart < NO_SHOW_CANCEL_WINDOW_MS) {
    return 'no_show_full';
  }
  return 'late_half';
}

/**
 * True when the cancellation happens in (0, 24h) before `bookingTime`.
 * Prefer `classifyClientCancelPenalty` for tiered charging.
 */
function isLateCancellationWindow(bookingTime) {
  return classifyClientCancelPenalty(bookingTime) !== 'none';
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
  if (s === 'no-show') return true;
  return false;
}

/**
 * Charge an off-session penalty. Never throws — callers log `{ ok: false }`
 * and still flip status to a non-penalized cancel when appropriate.
 *
 * @param {{
 *   stripeCustomerId: string,
 *   appointmentId: string | number,
 *   calBookingUid?: string | null,
 *   serviceLabel: string,
 *   amountCents: number,
 *   feeType?: 'late_cancel_penalty' | 'no_show_penalty',
 *   description?: string,
 *   penaltyFraction?: number,
 * }} params
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

  const amountCents = params.amountCents;
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    return {
      ok: false,
      error: 'invalid_service_price',
      message:
        'Could not determine a service price for this appointment. Add a matching service price before charging a cancel fee.',
    };
  }

  const feeType = params.feeType || 'late_cancel_penalty';
  const description = (
    params.description ||
    (feeType === 'no_show_penalty'
      ? `No-show fee — ${params.serviceLabel}`
      : `Late cancellation fee — ${params.serviceLabel}`)
  ).slice(0, 500);

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

    const metadata = {
      appointment_id: String(params.appointmentId),
      ...(params.calBookingUid
        ? { cal_booking_uid: params.calBookingUid }
        : {}),
      fee_type: feeType,
    };
    if (
      params.penaltyFraction != null &&
      Number.isFinite(params.penaltyFraction)
    ) {
      metadata.penalty_fraction = String(params.penaltyFraction);
    }

    // Stable idempotency key: a network timeout misread as failure (which
    // releases the webhook's dedupe claim) must replay this charge on retry
    // instead of double-charging. A new card or changed amount gets a fresh
    // key, so deliberate re-attempts still work.
    const idempotencyKey = `fee:${feeType}:${params.appointmentId}:${paymentMethod.id}:${Math.round(amountCents)}`;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amountCents),
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethod.id,
        off_session: true,
        confirm: true,
        statement_descriptor_suffix: 'SADIE MARIE',
        description,
        metadata,
      },
      { idempotencyKey }
    );

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
      amountCents: Math.round(amountCents),
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
  NO_SHOW_CANCEL_WINDOW_MS,
  LATE_CANCEL_FRACTION,
  NO_SHOW_CANCEL_FRACTION,
  penaltyAmountCents,
  classifyClientCancelPenalty,
  isLateCancellationWindow,
  isAdminCancellationReason,
  shouldSkipLateCancelPenalty,
  chargeLateCancelFee,
};
