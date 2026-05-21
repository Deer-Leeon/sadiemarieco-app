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
};
