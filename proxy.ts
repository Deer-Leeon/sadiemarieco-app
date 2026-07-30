import { clerkMiddleware, createRouteMatcher, clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { isAllowedAdminEmail } from '@/lib/admin-allowlist';
import {
  PRODUCTION_SITE_URL,
  shouldGateAsStaging,
} from '@/lib/staging';

const isAdminRoute = createRouteMatcher([
  '/admin(.*)',
  '/api/admin(.*)',
  '/api/upload',
]);

/**
 * Staging must allow the in-app sign-in flow. Clerk scopes `__session` to the
 * app host and does not share it across subdomains, so a live `/admin`
 * session on www/apex does not unlock `staging.sadiemarie.co` — admins sign
 * in again on staging (same Clerk Production users / keys).
 */
const isStagingSignInRoute = createRouteMatcher(['/sign-in(.*)']);

/** Production paths that must not run Clerk session parsing (Bearer cron / webhooks). */
const isClerkExcludedApi = createRouteMatcher([
  '/api/webhook(.*)',
  '/api/webhooks(.*)',
  '/api/cron(.*)',
  '/api/remind(.*)',
  '/api/feedback(.*)',
  '/api/qstash(.*)',
  '/api/reviews(.*)',
]);
async function userHasAdminAccess(userId: string): Promise<boolean> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const emails =
    user.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];
  return emails.some((email) => isAllowedAdminEmail(email));
}

/**
 * Auth proxy (Next.js 16: `middleware.ts` → `proxy.ts`).
 *
 * Production: Clerk session only for admin surfaces.
 * Staging (`staging.sadiemarie.co` or APP_ENV=staging): public marketing is
 * hidden (redirect to production). `/admin` behaves like live — unsigned
 * visitors are sent to staging `/sign-in`, then allowlisted admins proceed.
 */
export default clerkMiddleware(async (auth, req) => {
  const host = req.headers.get('host');
  const staging = shouldGateAsStaging(host);

  if (staging) {
    // Let the in-app Clerk widget run on this host (session cookies are
    // host-scoped; live www login does not unlock staging).
    if (isStagingSignInRoute(req)) {
      return;
    }

    const session = await auth();

    // Same UX as production admin: protect → local /sign-in, not a bounce
    // to www (which looked like "I'm logged in but staging redirects me").
    if (!session.userId && isAdminRoute(req)) {
      await auth.protect();
      return;
    }

    if (!session.userId) {
      return NextResponse.redirect(PRODUCTION_SITE_URL);
    }

    const allowed = await userHasAdminAccess(session.userId);
    if (!allowed) {
      return NextResponse.redirect(PRODUCTION_SITE_URL);
    }
    return;
  }

  // Production: never touch Clerk for cron/webhook Bearer routes.
  if (isClerkExcludedApi(req)) {
    return;
  }

  if (isAdminRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    /*
     * Run on all app routes except Next internals and common static assets.
     * Staging gate needs the homepage and marketing HTML; production still
     * only *protects* admin routes (see logic above).
     */
    '/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff2?|mp4|webm)$).*)',
  ],
};
