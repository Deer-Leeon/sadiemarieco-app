/**
 * Browser Stripe.js singleton — call `loadStripe` once per page load.
 * Shared by `/checkout` and phone `/book` Apple Pay.
 *
 * Hide Stripe’s test-mode “Developers” floating assistant — it sits on
 * top of our sticky Continue / Apple Pay CTAs on phone `/book`.
 * @see https://docs.stripe.com/sdks/stripejs-testing-assistant
 */

import { loadStripe, type Stripe } from '@stripe/stripe-js';

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export const stripePublishableKey = STRIPE_PK;

export const stripePromise: Promise<Stripe | null> | null = STRIPE_PK
  ? loadStripe(STRIPE_PK, {
      developerTools: {
        assistant: {
          enabled: false,
        },
      },
    } as Parameters<typeof loadStripe>[1])
  : null;
