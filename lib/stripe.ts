/**
 * Shared Stripe SDK singleton.
 *
 * Imported by every route under `app/api/stripe/**` and
 * `app/api/booking/**` so:
 *   • we pin the API version in exactly one place (avoiding silent
 *     breakage when Stripe ships a new pinned version on the dashboard
 *     side and Node SDKs that don't override would auto-upgrade),
 *   • `process.env.STRIPE_SECRET_KEY` is read at module-init time and
 *     the missing-key error surfaces immediately at cold start
 *     instead of as a confusing TypeError on the first checkout
 *     attempt.
 *
 * Server-only. The browser must never see this module — putting it
 * under `lib/` (not `app/api/_lib`) keeps it out of Next's app routing
 * but still importable by any server route with `import { stripe } from
 * '@/lib/stripe'`.
 */
import Stripe from 'stripe';

const SECRET = process.env.STRIPE_SECRET_KEY;

if (!SECRET && process.env.NODE_ENV === 'production') {
  // Hard-fail in production builds. In development we still construct
  // a Stripe client below so the route can return a structured error
  // ("stripe_not_configured") rather than 500ing on undefined.SDK init.
  throw new Error(
    'STRIPE_SECRET_KEY is required in production but is not set'
  );
}

/**
 * `null` when the key is missing in non-production — every route that
 * uses this MUST handle the null branch and return a 503 with a
 * "stripe_not_configured" code so the UI can surface a clear message.
 *
 * The API version is whatever the Stripe SDK considers its latest at
 * the time of `npm install` — we deliberately do NOT pin a date string
 * here because Stripe's TS types are generated against that latest
 * version, and pinning to an older string can break type compatibility
 * (e.g. `Stripe.SetupIntent.Status` adds new union members in newer
 * versions). The SDK falls back to its compiled-in default when
 * `apiVersion` is omitted, which is the safest posture for a TS
 * codebase that re-installs whenever the SDK is bumped.
 */
export const stripe: Stripe | null = SECRET
  ? new Stripe(SECRET, {
      typescript: true,
    })
  : null;
