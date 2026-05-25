import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/admin(.*)']);

/**
 * Auth proxy.
 *
 * Renamed from middleware.ts → proxy.ts for Next.js 16's new file
 * convention. See https://nextjs.org/docs/messages/middleware-to-proxy.
 * Behaviour is identical to a Next.js middleware file; the API surface
 * (`clerkMiddleware`, default export, `config` export) is unchanged.
 *
 * Two things happen here:
 *   1. clerkMiddleware() initialises Clerk's request context so that
 *      `auth()` and `currentUser()` work inside Server Components and
 *      App Router route handlers downstream.
 *   2. Routes matched by `isProtectedRoute` (currently /admin/*) are
 *      gated — unauthenticated requests get redirected to /sign-in.
 *
 * Matcher scope:
 *   - `/admin(/:path*)` — admin dashboard (gated by isProtectedRoute).
 *   - `/(api|trpc)(.*)` — all App Router API routes. Required so that
 *     `app/api/upload/route.ts` (and any future auth-needing API
 *     handler) can call `auth()` inside its body. The proxy does NOT
 *     protect /api/* — `isProtectedRoute` excludes those paths — it
 *     just wires up the Clerk request context.
 *
 * Side effect — legacy handlers (lib/legacy-handlers/*, mounted at
 *   /api/webhook, /api/remind, /api/feedback, /api/cancel-booking,
 *   /api/booking via app/api/*/route.js) share the /api/* prefix and authenticate
 *   themselves via signature checks (QStash signature, Cal.com
 *   signature). With this matcher, requests to those URLs hit the
 *   Next.js proxy first, adding a few ms of Clerk context setup
 *   overhead per webhook/QStash call. None of them are gated by
 *   `isProtectedRoute`, so behaviour is unchanged — only latency
 *   slightly increases. If that ever becomes meaningful, narrow the
 *   matcher to the specific App Router routes that need Clerk auth
 *   (e.g. '/api/upload(.*)') instead of the broad '/(api|trpc)(.*)'.
 */
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ['/admin', '/admin/:path*', '/(api|trpc)(.*)'],
  // NOTE: No `runtime` field here. Under the Next.js 16 proxy file
  // convention, proxies ALWAYS run on the Node.js runtime — the old
  // `runtime: 'nodejs'` opt-in from middleware.ts is now redundant and,
  // worse, rejected with a hard error at startup:
  //   "Route segment config is not allowed in Proxy file"
  // See https://nextjs.org/docs/messages/middleware-to-proxy. Clerk's
  // Node-only crypto / dynamic-require dependencies are still satisfied
  // because Node is the default and only runtime for proxy.ts.
};
