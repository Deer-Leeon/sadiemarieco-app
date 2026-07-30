/**
 * Shared admin authorisation helpers.
 *
 * Both server-rendered admin pages AND server-side API routes (uploads,
 * future CMS writes, etc.) need to enforce the exact same allowlist. If
 * one surface drifts from the other we end up with a soft side door —
 * keep both reading from this single source of truth.
 *
 * Defence-in-depth note: proxy.ts already enforces "signed in" for
 * /admin/** (and the full staging host). This file enforces "signed in
 * AND on the allowlist" for privileged work. Production API routes under
 * /api/admin/** must still call `requireAdminUser` themselves.
 */
import { auth, currentUser } from '@clerk/nextjs/server';

import { ALLOWED_ADMIN_EMAILS } from '@/lib/admin-allowlist';

export { ALLOWED_ADMIN_EMAILS };

export interface AdminAccessResult {
  /** Clerk user id, or null if unauthenticated. */
  userId: string | null;
  /** All verified+unverified linked emails (lowercased). */
  emails: string[];
  /** True iff at least one email is on `ALLOWED_ADMIN_EMAILS`. */
  hasAccess: boolean;
}

/**
 * Returns auth state without throwing or redirecting. Use this in
 * server components when you want to handle the "no access" case
 * yourself (e.g. redirecting to `/`).
 */
export async function getAdminAccess(): Promise<AdminAccessResult> {
  const { userId } = await auth();
  if (!userId) {
    return { userId: null, emails: [], hasAccess: false };
  }
  const user = await currentUser();
  const emails =
    user?.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];
  const hasAccess = emails.some((e) => ALLOWED_ADMIN_EMAILS.has(e));
  return { userId, emails, hasAccess };
}

/**
 * Strict variant for API routes: returns the authorised user info, or
 * `null` if the request should be rejected. The route handler decides
 * which status code to return (401 vs 403) based on the userId/emails
 * fields of the failed result. We keep that decision out of the helper
 * so route handlers can format the response in whatever shape they want.
 */
export async function requireAdminUser(): Promise<
  | { ok: true; userId: string; emails: string[] }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' }
> {
  const result = await getAdminAccess();
  if (!result.userId) return { ok: false, reason: 'unauthenticated' };
  if (!result.hasAccess) return { ok: false, reason: 'forbidden' };
  return { ok: true, userId: result.userId, emails: result.emails };
}
