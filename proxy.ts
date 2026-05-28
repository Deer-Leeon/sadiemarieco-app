import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/admin(.*)']);

/**
 * Auth proxy (Next.js 16: `middleware.ts` → `proxy.ts`).
 *
 * Matcher is limited to routes that need Clerk session auth. Cron routes,
 * webhooks, and `/api/reviews` are excluded so Bearer / X-Cron-Secret are
 * never parsed as Clerk JWTs.
 */
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/admin',
    '/admin/:path*',
    '/api/admin/:path*',
    '/api/upload',
  ],
};
