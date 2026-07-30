/**
 * Single source of truth for who may access admin / staging.
 * Keep in sync with any Clerk Dashboard role changes.
 */
export const ALLOWED_ADMIN_EMAILS: ReadonlySet<string> = new Set([
  'lj.buchmiller@gmail.com',
  'mckenna@sadiemarie.co',
]);

export function isAllowedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWED_ADMIN_EMAILS.has(email.trim().toLowerCase());
}
