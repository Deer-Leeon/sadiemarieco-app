/**
 * Staging host detection + production redirect target.
 * Used by proxy.ts so the public never sees staging without an admin session.
 */

export const PRODUCTION_SITE_URL = 'https://www.sadiemarie.co';

export function isStagingHost(hostHeader: string | null): boolean {
  const host = (hostHeader || '').split(':')[0].toLowerCase();
  if (host === 'staging.sadiemarie.co') return true;
  return false;
}

/**
 * True when this deployment should behave as staging (gate + no SMS).
 * Prefer APP_ENV=staging on the Vercel staging branch env.
 */
export function isStagingDeployment(): boolean {
  if (process.env.APP_ENV === 'staging') return true;
  if (process.env.VERCEL_GIT_COMMIT_REF === 'staging') return true;
  return false;
}

export function shouldGateAsStaging(hostHeader: string | null): boolean {
  return isStagingHost(hostHeader) || isStagingDeployment();
}
