/**
 * Browser Stripe.js singleton — call `loadStripe` once per page load.
 * Shared by `/checkout` and phone `/book` Apple Pay.
 */

import { loadStripe, type Stripe } from '@stripe/stripe-js';

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export const stripePublishableKey = STRIPE_PK;

export const stripePromise: Promise<Stripe | null> | null = STRIPE_PK
  ? loadStripe(STRIPE_PK)
  : null;
