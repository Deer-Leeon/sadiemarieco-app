/**
 * Pay-now prepaid cancel / no-show policy: refund via the original
 * PaymentIntent instead of a second off-session charge.
 *
 * keepFraction:
 *   0   → full refund (cancel outside policy window / admin cancel)
 *   0.5 → refund half (late cancel)
 *   1   → no refund (no-show / cancel inside 2h)
 *
 * CommonJS so legacy webhook handlers can require() it.
 */

const Stripe = require('stripe');

const STRIPE_PAYMENT_INTENT_ID_RE = /^pi_[A-Za-z0-9_]+$/;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

function isPrepaidPayNowAppointment(row) {
  if (!row || typeof row !== 'object') return false;
  const timing = String(row.payment_timing || '').trim();
  const pi = String(row.stripe_payment_intent_id || '').trim();
  return timing === 'pay_now' && STRIPE_PAYMENT_INTENT_ID_RE.test(pi);
}

/**
 * @param {{
 *   paymentIntentId: string,
 *   keepFraction: number,
 *   appointmentId?: string | number | null,
 *   calBookingUid?: string | null,
 *   reason?: string,
 *   feeType?: string,
 * }} params
 */
async function refundPrepaidBooking(params) {
  const stripe = getStripe();
  if (!stripe) {
    return {
      ok: false,
      error: 'stripe_not_configured',
      message: 'Stripe is not configured on the server.',
    };
  }

  const paymentIntentId = String(params.paymentIntentId || '').trim();
  if (!STRIPE_PAYMENT_INTENT_ID_RE.test(paymentIntentId)) {
    return {
      ok: false,
      error: 'invalid_payment_intent_id',
      message: 'Missing prepaid PaymentIntent for this booking.',
    };
  }

  const keepFraction = Number(params.keepFraction);
  if (!Number.isFinite(keepFraction) || keepFraction < 0 || keepFraction > 1) {
    return {
      ok: false,
      error: 'invalid_keep_fraction',
      message: 'Invalid prepaid refund keep fraction.',
    };
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') {
      return {
        ok: false,
        error: 'payment_intent_not_succeeded',
        message: `Prepaid PaymentIntent is ${pi.status}, not succeeded.`,
      };
    }

    const chargedCents = Number(pi.amount_received || pi.amount || 0);
    if (!Number.isFinite(chargedCents) || chargedCents < 50) {
      return {
        ok: false,
        error: 'invalid_prepaid_amount',
        message: 'Could not determine the prepaid charge amount to refund.',
      };
    }

    const alreadyRefunded = Number(pi.amount_refunded || 0);
    const refundable = Math.max(0, chargedCents - alreadyRefunded);
    const keepCents = Math.round(chargedCents * keepFraction);
    const desiredRefund = Math.max(0, chargedCents - keepCents);
    const refundAmountCents = Math.min(refundable, desiredRefund);

    if (refundAmountCents < 50) {
      return {
        ok: true,
        skipped: refundAmountCents <= 0 ? 'nothing_to_refund' : 'below_minimum',
        paymentIntentId,
        amountCents: chargedCents,
        refundAmountCents: 0,
        keptAmountCents: chargedCents - alreadyRefunded,
        currency: pi.currency || 'usd',
      };
    }

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: refundAmountCents,
      reason: 'requested_by_customer',
      metadata: {
        appointment_id: params.appointmentId
          ? String(params.appointmentId)
          : '',
        ...(params.calBookingUid
          ? { cal_booking_uid: String(params.calBookingUid) }
          : {}),
        fee_type: params.feeType || 'prepaid_policy_refund',
        keep_fraction: String(keepFraction),
        note: (params.reason || 'Prepaid booking policy refund').slice(0, 500),
      },
    });

    return {
      ok: true,
      paymentIntentId,
      refundId: refund.id,
      amountCents: chargedCents,
      refundAmountCents,
      keptAmountCents: chargedCents - alreadyRefunded - refundAmountCents,
      currency: refund.currency || pi.currency || 'usd',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[prepaid-booking-refund] refund failed', {
      paymentIntentId,
      error: message,
    });
    return {
      ok: false,
      error: 'stripe_refund_failed',
      message,
    };
  }
}

module.exports = {
  STRIPE_PAYMENT_INTENT_ID_RE,
  isPrepaidPayNowAppointment,
  refundPrepaidBooking,
};
