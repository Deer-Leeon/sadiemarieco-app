import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/admin(.*)']);

/**
 * Auth middleware.
 *
 * Why a narrow matcher (admin only) rather than Clerk's broader default
 * "everything except _next + static assets":
 *
 *   - The standalone Vercel Functions in /api/* (webhook, remind, feedback,
 *     cancel-booking, booking) authenticate themselves: QStash callbacks
 *     verify the Upstash signature, Cal webhooks would verify Cal's
 *     signature if/when we add it. Wrapping them in Clerk's edge middleware
 *     adds latency and a failure mode we don't need.
 *   - / and /manage.html are intentionally public marketing/portal pages.
 *   - Restricting the matcher to /admin means a Clerk outage cannot take
 *     down the public site or the booking webhooks.
 */
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ['/admin', '/admin/:path*'],
  // Force the Node.js runtime instead of the default Edge runtime. Clerk's
  // middleware relies on Node-only APIs (crypto internals, dynamic require
  // paths) that the Edge runtime does not expose, which manifests as a
  // build/runtime error on Vercel. The trade-off is a slightly cooler cold
  // start than Edge, which is acceptable since this matcher only fires on
  // /admin requests (a low-volume internal route).
  runtime: 'nodejs',
};
