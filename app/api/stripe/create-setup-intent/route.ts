/**
 * POST /api/stripe/create-setup-intent
 *
 * Initialises a Stripe SetupIntent used by the /checkout page to vault
 * a client's card BEFORE the booking is finalised. The Element on the
 * page collects the card, calls `stripe.confirmSetup()` against the
 * client_secret we return here, and the resulting PaymentMethod is
 * attached to a Customer in the subsequent `/api/booking/confirm` call.
 *
 * `usage: 'off_session'` is the load-bearing setting:
 *   • Tells Stripe to capture all extra authentication factors NOW
 *     (3DS challenge if the issuer needs one, CVC, address-verification
 *     mandate text on EU cards) so we can charge later without the
 *     client present.
 *   • The PaymentMethod returned satisfies SCA "mandate" rules in the
 *     EU and unlocks `confirm({ off_session: true })` on subsequent
 *     PaymentIntents (no-show / late-cancel fees).
 *
 * No body required — the SetupIntent isn't associated with a customer
 * here (Stripe lets us attach to one at confirm time on the next route).
 * If we ever need to dedupe cards per-client across multiple bookings,
 * accept an optional `customerId` in the body and pass it as `customer`
 * to setupIntents.create — but for v1 we explicitly want a new vault
 * per booking so admin re-issue of a card-on-file stays isolated.
 *
 * Returns `{ clientSecret }`. Errors return a JSON shape consistent
 * with the rest of the admin API (`{ error: 'code', message?: string }`)
 * so the client can branch deterministically.
 */
import { NextResponse } from 'next/server';

import { stripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(): Promise<NextResponse> {
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

  try {
    const setupIntent = await stripe.setupIntents.create({
      usage: 'off_session',
      // Restrict to card. The PaymentElement defaults to "every method
      // enabled on the dashboard"; pinning to card here means a stray
      // Klarna/Affirm toggle in the Stripe UI can't suddenly let a
      // client "vault" a non-vaultable method that we then can't use
      // off-session for cancellation fees.
      payment_method_types: ['card'],
    });

    if (!setupIntent.client_secret) {
      // Defensive — Stripe's SDK types client_secret as `string | null`
      // but in practice it's only null for archived/expired intents
      // (which a fresh create can't return). Treat as a server fault
      // so the client doesn't get a half-baked Element session.
      console.error(
        '[api/stripe/create-setup-intent] SetupIntent created without client_secret',
        { id: setupIntent.id }
      );
      return NextResponse.json(
        { error: 'missing_client_secret' },
        { status: 500 }
      );
    }

    return NextResponse.json({ clientSecret: setupIntent.client_secret });
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
