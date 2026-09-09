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
 * True when this deployment should behave as staging (gate + SMS toggle).
 * Prefer APP_ENV=staging on the Vercel staging branch env.
 */
export function isStagingDeployment(): boolean {
  if (process.env.APP_ENV === 'staging') return true;
  if (process.env.VERCEL_GIT_COMMIT_REF === 'staging') return true;
  return false;
}

/**
 * Live marketing hosts must never use the staging gate, even if this build
 * was created on the staging git branch (e.g. a Preview promoted to
 * Production). Middleware inlines APP_ENV / VERCEL_GIT_COMMIT_REF at
 * build time, so a promoted staging build would otherwise 307 www → www.
 */
function isProductionPublicHost(hostHeader: string | null): boolean {
  const host = (hostHeader || '').split(':')[0].toLowerCase();
  return host === 'www.sadiemarie.co' || host === 'sadiemarie.co';
}

export function shouldGateAsStaging(hostHeader: string | null): boolean {
  if (isProductionPublicHost(hostHeader)) return false;
  return isStagingHost(hostHeader) || isStagingDeployment();
}
