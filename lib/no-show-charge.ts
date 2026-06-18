import Stripe from 'stripe';

import { STRIPE_CUSTOMER_ID_RE } from '@/lib/appointment-stripe';
import {
  NO_SHOW_PENALTY_FRACTION,
  penaltyAmountCents,
} from '@/lib/no-show-penalty';
import { stripe } from '@/lib/stripe';

export { NO_SHOW_PENALTY_FRACTION, penaltyAmountCents };

export interface NoShowChargeSuccess {
  paymentIntentId: string;
  amountCents: number;
  currency: string;
}

export interface NoShowChargeFailure {
  error: string;
  message: string;
  status: number;
}

/**
 * Charge 50% of the service price off-session against the vaulted card.
 */
export async function chargeNoShowPenalty(params: {
  stripeCustomerId: string;
  servicePriceDollars: number;
  appointmentId: string;
  calBookingUid: string | null;
  serviceLabel: string;
}): Promise<NoShowChargeSuccess | NoShowChargeFailure> {
  if (!stripe) {
    return {
      error: 'stripe_not_configured',
      message: 'Stripe is not configured on the server.',
      status: 503,
    };
  }

  if (!STRIPE_CUSTOMER_ID_RE.test(params.stripeCustomerId)) {
    return {
      error: 'invalid_stripe_customer_id',
      message: 'This appointment has no valid vaulted card on file.',
      status: 400,
    };
  }

  const amountCents = penaltyAmountCents(params.servicePriceDollars);
  if (amountCents < 50) {
    return {
      error: 'invalid_service_price',
      message:
        'Could not determine a service price for this appointment. Add a matching service price before charging a no-show fee.',
      status: 400,
    };
  }

  try {
    const methods = await stripe.paymentMethods.list({
      customer: params.stripeCustomerId,
      type: 'card',
    });

    const paymentMethod = methods.data[0];
    if (!paymentMethod) {
      return {
        error: 'no_payment_method',
        message:
          'No card is saved on file for this client. They may not have completed checkout.',
        status: 400,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: params.stripeCustomerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      description: `No-show fee (50%) — ${params.serviceLabel}`.slice(0, 500),
      metadata: {
        appointment_id: String(params.appointmentId),
        ...(params.calBookingUid
          ? { cal_booking_uid: params.calBookingUid }
          : {}),
        fee_type: 'no_show_penalty',
        penalty_fraction: String(NO_SHOW_PENALTY_FRACTION),
      },
    });

    if (paymentIntent.status !== 'succeeded') {
      return {
        error: 'payment_not_completed',
        message: `The charge did not complete (status: ${paymentIntent.status}).`,
        status: 402,
      };
    }

    return {
      paymentIntentId: paymentIntent.id,
      amountCents,
      currency: paymentIntent.currency ?? 'usd',
    };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      const decline =
        err.decline_code && err.decline_code !== 'generic_decline'
          ? `${err.message} (${err.decline_code})`
          : err.message;
      return {
        error: 'card_declined',
        message: decline ?? 'The card was declined.',
        status: 402,
      };
    }

    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      const code = err.code ?? '';
      if (
        code === 'authentication_required' ||
        err.message?.includes('authentication')
      ) {
        return {
          error: 'authentication_required',
          message:
            'This card requires additional authentication and cannot be charged off-session. Ask the client to update their card on file.',
          status: 402,
        };
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[no-show-charge] Stripe charge failed', {
      appointmentId: params.appointmentId,
      error: message,
    });
    return {
      error: 'stripe_charge_failed',
      message,
      status: 502,
    };
  }
}
