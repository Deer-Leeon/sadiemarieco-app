/**
 * Shared Stripe SDK singleton.
 *
 * Imported by every route under `app/api/stripe/**` and
 * `app/api/booking/**` so:
 *   • we pin the API version in exactly one place (avoiding silent
 *     breakage when Stripe ships a new pinned version on the dashboard
 *     side and Node SDKs that don't override would auto-upgrade),
 *   • `process.env.STRIPE_SECRET_KEY` is read at module-init time and
 *     routes can return a consistent `stripe_not_configured` response
 *     when it is absent.
 *
 * Server-only. The browser must never see this module — putting it
 * under `lib/` (not `app/api/_lib`) keeps it out of Next's app routing
 * but still importable by any server route with `import { stripe } from
 * '@/lib/stripe'`.
 */
import Stripe from 'stripe';

const SECRET = process.env.STRIPE_SECRET_KEY;

/**
 * `null` when the key is missing — every route that uses this MUST handle the
 * null branch and return a 503 with a "stripe_not_configured" code.
 *
 * Do not throw at module evaluation time. Next evaluates route modules while
 * collecting build output, and build workers don't always receive runtime
 * secrets. Runtime health checks still treat a missing key as unhealthy.
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
