import { clerkMiddleware, createRouteMatcher, clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { isAllowedAdminEmail } from '@/lib/admin-allowlist';
import { isReverieBeautyHost } from '@/lib/reverie-beauty-host';
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

/**
 * Booking checkout must stay on the staging host + staging DB. If these
 * routes redirect to www, `/api/booking/init` follows the 307 and writes
 * the hold on production while the browser stays on staging `/checkout`
 * (countdown disappears; shared Cal slot is held against the wrong DB).
 * Not marketing pages — `/checkout` is useless without a Cal uid.
 */
const isStagingCheckoutPipelineRoute = createRouteMatcher([
  '/checkout(.*)',
  '/book(.*)',
  '/api/booking(.*)',
  '/api/book(.*)',
  '/api/stripe(.*)',
]);

/**
 * Apple Pay / Payment Method Domains verification fetches this without a
 * Clerk session. Staging must not 307 → www or Safari never enables Apple Pay
 * for `staging.sadiemarie.co` (especially Stripe test mode).
 */
const isApplePayDomainAssociation = createRouteMatcher([
  '/.well-known/apple-developer-merchantid-domain-association',
]);

/** Public Reverie Beauty handoff — previewable on staging without a Clerk session. */
const isReverieBeautyPreviewRoute = createRouteMatcher([
  '/reveriebeauty',
  '/reverie-beauty.html',
]);

/** Production paths that must not run Clerk session parsing (Bearer cron / webhooks). */
const isClerkExcludedApi = createRouteMatcher([
  '/api/webhook(.*)',
  '/api/webhooks(.*)',
  '/api/cron(.*)',
  '/api/remind(.*)',
  '/api/remind-email(.*)',
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
 * hidden (redirect to production). Checkout + booking/stripe APIs stay on
 * this host so holds are not written to production. `/admin` behaves like
 * live — unsigned visitors are sent to staging `/sign-in`, then allowlisted
 * admins proceed.
 */
export default clerkMiddleware(async (auth, req) => {
  const host = req.headers.get('host');

  // Dedicated client-handoff host: every path shows the welcome card.
  if (isReverieBeautyHost(host)) {
    const url = req.nextUrl.clone();
    url.pathname = '/reverie-beauty.html';
    return NextResponse.rewrite(url);
  }

  const staging = shouldGateAsStaging(host);

  if (staging) {
    // Let the in-app Clerk widget run on this host (session cookies are
    // host-scoped; live www login does not unlock staging).
    if (isStagingSignInRoute(req)) {
      return;
    }

    if (isApplePayDomainAssociation(req)) {
      return;
    }

    if (isReverieBeautyPreviewRoute(req)) {
      return;
    }

    if (isStagingCheckoutPipelineRoute(req)) {
      return;
    }

    const session = await auth();

    // Same UX as production admin, but keep the user on this host. Prefer an
    // explicit local redirect over auth.protect() so a mis-set absolute
    // NEXT_PUBLIC_CLERK_SIGN_IN_URL cannot bounce staging → www/apex.
    if (!session.userId && isAdminRoute(req)) {
      const signIn = new URL('/sign-in', req.nextUrl.origin);
      signIn.searchParams.set('redirect_url', req.nextUrl.href);
      return NextResponse.redirect(signIn);
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
