/**
 * POST /api/stripe/create-booking-payment-intent
 *
 * Pay-now bootstrap for phone /book:
 *   1. Resolve (or create) Stripe Customer from Cal booking context.
 *   2. Create a PaymentIntent for the quoted service plus an optional tip.
 *      amount_details.tip marks the tip. setup_future_usage keeps the card
 *      on file after the charge.
 *   3. Persist stripe_payment_intent_id on the pending appointment.
 *   4. Return { clientSecret } for Elements confirmPayment.
 */
import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';

import {
  getAppointmentStripeByCalUid,
  saveAppointmentStripePaymentIntent,
  STRIPE_CUSTOMER_ID_RE,
  STRIPE_PAYMENT_INTENT_ID_RE,
} from '@/lib/appointment-stripe';
import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import { HOLD_EXPIRED_MESSAGE, isAbandonedCheckoutHold } from '@/lib/booking-hold';
import { isValidEmail } from '@/lib/client-identity';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';
import {
  getStripeEnvModes,
  shouldEnforceStripeMode,
  stripeModeMismatchMessage,
} from '@/lib/stripe-mode';
import {
  isTipPreset,
  resolveTipCents,
  type TipPreset,
} from '@/lib/booking-tip';
import { stripe } from '@/lib/stripe';
import { stripeCardStatementFields } from '@/lib/stripe-statement-descriptor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CreateBody {
  calBookingUid?: unknown;
  email?: unknown;
  name?: unknown;
  tipPreset?: unknown;
  tipCents?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBody(input: unknown): {
  calBookingUid: string;
  email: string;
  name: string;
  tipPreset: TipPreset;
  tipCents: number | null;
} | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body' };
  }
  const body = input as CreateBody;
  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';

  if (!calBookingUid || calBookingUid.length > 200) {
    return { error: 'invalid_cal_booking_uid' };
  }

  let tipPreset: TipPreset = 'none';
  if (body.tipPreset != null && body.tipPreset !== '') {
    if (!isTipPreset(body.tipPreset)) return { error: 'invalid_tip' };
    tipPreset = body.tipPreset;
  }
  const tipCents =
    typeof body.tipCents === 'number' && Number.isSafeInteger(body.tipCents)
      ? body.tipCents
      : null;

  return {
    calBookingUid,
    email: isValidEmail(rawEmail) ? rawEmail.trim().toLowerCase() : '',
    name: rawName.length > 0 && rawName.length <= 200 ? rawName : '',
    tipPreset,
    tipCents,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `stripe:booking-payment-intent:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.stripeSetupIntent,
  });
  if (limited) return limited;

  if (!stripe) {
    return NextResponse.json(
      {
        error: 'stripe_not_configured',
        message:
          'STRIPE_SECRET_KEY is not set on the server. Card payments are unavailable.',
      },
      { status: 503 }
    );
  }

  const stripeModes = getStripeEnvModes();
  if (shouldEnforceStripeMode() && !stripeModes.matchesExpected) {
    const message = stripeModeMismatchMessage(stripeModes);
    console.error(
      '[api/stripe/create-booking-payment-intent] stripe mode mismatch',
      {
        secret: stripeModes.secret,
        publishable: stripeModes.publishable,
        expected: stripeModes.expected,
      }
    );
    return NextResponse.json(
      { error: 'stripe_mode_mismatch', message },
      { status: 503 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { calBookingUid, email, name, tipPreset, tipCents: requestedTipCents } = parsed;

  try {
    const hold = await getAppointmentHoldByCalUid(calBookingUid);
    if (!hold) {
      return NextResponse.json(
        {
          error: 'appointment_not_found',
          message:
            'This booking hold was not found. Please pick a time on the calendar again.',
        },
        { status: 404 }
      );
    }
    const status = (hold.status || '').toLowerCase();
    if (status === 'confirmed') {
      // Already paid/confirmed — never mint another PaymentIntent for this
      // booking (double-charge guard: back button / refresh inside the hold
      // window used to reach this route again).
      return NextResponse.json(
        {
          error: 'already_confirmed',
          message:
            'This booking is already confirmed. You have not been charged again.',
        },
        { status: 409 }
      );
    }
    if (
      (status && status !== 'pending') ||
      isAbandonedCheckoutHold(status, hold.created_at)
    ) {
      return NextResponse.json(
        { error: 'cart_hold_expired', message: HOLD_EXPIRED_MESSAGE },
        { status: 400 }
      );
    }

    const existing = await getAppointmentStripeByCalUid(calBookingUid);
    const serviceCents = Number(existing?.quoted_service_price_cents ?? 0);
    if (!Number.isSafeInteger(serviceCents) || serviceCents < 50) {
      return NextResponse.json(
        {
          error: 'invalid_service_price',
          message:
            'Could not determine the service price for this booking. Please pick a time again.',
        },
        { status: 400 }
      );
    }
    const tip = resolveTipCents(serviceCents, tipPreset, requestedTipCents);
    if (!tip.ok) {
      return NextResponse.json(
        {
          error: 'invalid_tip',
          message: 'Enter a tip from $1 up to twice the service price, or choose no tip.',
        },
        { status: 400 }
      );
    }
    const tipCents = tip.tipCents;
    const amountCents = serviceCents + tipCents;

    let stripeCustomerId =
      existing?.stripe_customer_id &&
      STRIPE_CUSTOMER_ID_RE.test(existing.stripe_customer_id)
        ? existing.stripe_customer_id
        : null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: email || undefined,
        name: name || undefined,
        metadata: { cal_booking_uid: calBookingUid },
      });
      stripeCustomerId = customer.id;
    } else if (email || name) {
      await stripe.customers.update(stripeCustomerId, {
        email: email || undefined,
        name: name || undefined,
      });
    }

    if (!STRIPE_CUSTOMER_ID_RE.test(stripeCustomerId)) {
      return NextResponse.json(
        { error: 'invalid_stripe_customer_id' },
        { status: 502 }
      );
    }

    const createParams: Stripe.PaymentIntentCreateParams = {
      amount: amountCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      setup_future_usage: 'off_session',
      ...stripeCardStatementFields,
      payment_method_options: {
        card: {
          request_three_d_secure: 'automatic',
        },
      },
      metadata: {
        cal_booking_uid: calBookingUid,
        payment_timing: 'pay_now',
        tip_cents: String(tipCents),
        tip_preset: tipPreset,
      },
      description:
        tipCents > 0 ? 'Service and tip at booking' : 'Service payment at booking',
    };
    if (tipCents > 0) {
      // Stripe categorizes this portion of the one charge as a tip.
      // The installed create-params type omits amount_details.tip; the
      // PaymentIntent object still returns it.
      (
        createParams as Stripe.PaymentIntentCreateParams & {
          amount_details: { tip: { amount: number } };
        }
      ).amount_details = { tip: { amount: tipCents } };
    }

    const paymentIntent = await stripe.paymentIntents.create(createParams);

    if (!paymentIntent.client_secret) {
      return NextResponse.json(
        { error: 'missing_client_secret' },
        { status: 500 }
      );
    }

    if (!STRIPE_PAYMENT_INTENT_ID_RE.test(paymentIntent.id)) {
      return NextResponse.json(
        { error: 'invalid_stripe_payment_intent_id' },
        { status: 502 }
      );
    }

    const dbLinked = await saveAppointmentStripePaymentIntent({
      calBookingUid,
      stripePaymentIntentId: paymentIntent.id,
    });

    if (!dbLinked) {
      // Row is no longer pending (confirmed/canceled raced us). Cancel the
      // fresh unconfirmed PI and refuse — returning a clientSecret here is
      // how double charges happen.
      console.warn(
        '[api/stripe/create-booking-payment-intent] no pending row to link PI — canceling intent',
        { calBookingUid, paymentIntentId: paymentIntent.id }
      );
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id);
      } catch (cancelErr) {
        console.warn(
          '[api/stripe/create-booking-payment-intent] PI cancel failed',
          errorMessage(cancelErr)
        );
      }
      return NextResponse.json(
        {
          error: 'booking_not_payable',
          message:
            'This booking can no longer be paid online. If you already paid, you are all set.',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      stripeCustomerId,
      paymentIntentId: paymentIntent.id,
      amountCents,
      serviceCents,
      tipCents,
      dbLinked,
    });
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      '[api/stripe/create-booking-payment-intent] failed:',
      msg
    );
    return NextResponse.json(
      { error: 'stripe_create_failed', message: msg },
      { status: 502 }
    );
  }
}
