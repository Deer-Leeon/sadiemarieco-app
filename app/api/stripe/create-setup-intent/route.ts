/**
 * POST /api/stripe/create-setup-intent
 *
 * Card-vault bootstrap for /checkout:
 *   1. Resolve (or create) a Stripe Customer from the Cal booking context.
 *   2. Create a SetupIntent (`usage: 'off_session'`) bound to that customer.
 *   3. Persist `stripe_setup_intent_id` on the pending `appointments` row
 *      (when it exists). `stripe_customer_id` is written only after confirm.
 *   4. Return `{ clientSecret }` for Stripe Elements + `confirmSetup()`.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  getAppointmentStripeByCalUid,
  saveAppointmentStripeSetupIntent,
  STRIPE_CUSTOMER_ID_RE,
  STRIPE_SETUP_INTENT_ID_RE,
} from '@/lib/appointment-stripe';
import { isValidEmail } from '@/lib/client-identity';
import { stripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CreateSetupIntentBody {
  calBookingUid?: unknown;
  email?: unknown;
  name?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBody(input: unknown): {
  calBookingUid: string;
  email: string;
  name: string;
} | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body' };
  }
  const body = input as CreateSetupIntentBody;
  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';

  if (!calBookingUid || calBookingUid.length > 200) {
    return { error: 'invalid_cal_booking_uid' };
  }

  return {
    calBookingUid,
    email: isValidEmail(rawEmail) ? rawEmail.trim().toLowerCase() : '',
    name: rawName.length > 0 && rawName.length <= 200 ? rawName : '',
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json(
      {
        error: 'stripe_not_configured',
        message:
          'STRIPE_SECRET_KEY is not set on the server. Card vaulting is unavailable.',
      },
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

  const { calBookingUid, email, name } = parsed;

  try {
    const existing = await getAppointmentStripeByCalUid(calBookingUid);

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

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: { cal_booking_uid: calBookingUid },
    });

    if (!setupIntent.client_secret) {
      console.error(
        '[api/stripe/create-setup-intent] SetupIntent created without client_secret',
        { id: setupIntent.id }
      );
      return NextResponse.json(
        { error: 'missing_client_secret' },
        { status: 500 }
      );
    }

    if (!STRIPE_SETUP_INTENT_ID_RE.test(setupIntent.id)) {
      return NextResponse.json(
        { error: 'invalid_stripe_setup_intent_id' },
        { status: 502 }
      );
    }

    const dbLinked = await saveAppointmentStripeSetupIntent({
      calBookingUid,
      stripeSetupIntentId: setupIntent.id,
    });

    if (!dbLinked) {
      console.warn(
        '[api/stripe/create-setup-intent] no pending appointment row to link Stripe ids',
        { calBookingUid, stripeCustomerId, setupIntentId: setupIntent.id }
      );
    }

    return NextResponse.json({
      clientSecret: setupIntent.client_secret,
      stripeCustomerId,
      setupIntentId: setupIntent.id,
      dbLinked,
    });
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      '[api/stripe/create-setup-intent] setupIntents.create failed:',
      msg
    );
    return NextResponse.json(
      { error: 'stripe_create_failed', message: msg },
      { status: 502 }
    );
  }
}
