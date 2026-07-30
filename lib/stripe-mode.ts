/**
 * Stripe live vs test key detection + expected mode for this deployment.
 *
 * Production (www.sadiemarie.co) must use `sk_live_` / `pk_live_` so
 * clients can only vault real cards. Staging must use `sk_test_` /
 * `pk_test_` so checkout can be exercised without charging anyone.
 */
import { isStagingDeployment } from '@/lib/staging';

export type StripeKeyMode = 'live' | 'test' | 'unknown';

export function stripeKeyMode(key: string | undefined | null): StripeKeyMode {
  if (!key) return 'unknown';
  if (key.startsWith('sk_live_') || key.startsWith('pk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('pk_test_')) return 'test';
  return 'unknown';
}

/**
 * Staging / non-production Vercel envs expect test keys.
 * Production deployments (and local without APP_ENV=staging) expect live
 * only when `VERCEL_ENV=production`; local `vercel dev` may keep test keys.
 */
export function expectedStripeMode(): StripeKeyMode {
  if (isStagingDeployment()) return 'test';
  if (process.env.VERCEL_ENV === 'production') return 'live';
  // Local / preview (non-staging): prefer test so accidental live keys
  // on Development don't charge during day-to-day work.
  if (process.env.VERCEL_ENV === 'preview') return 'test';
  return 'test';
}

export function getStripeEnvModes(): {
  secret: StripeKeyMode;
  publishable: StripeKeyMode;
  expected: StripeKeyMode;
  aligned: boolean;
  matchesExpected: boolean;
} {
  const secret = stripeKeyMode(process.env.STRIPE_SECRET_KEY);
  const publishable = stripeKeyMode(
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  );
  const expected = expectedStripeMode();
  const aligned =
    secret !== 'unknown' &&
    publishable !== 'unknown' &&
    secret === publishable;
  const matchesExpected = aligned && secret === expected;
  return { secret, publishable, expected, aligned, matchesExpected };
}

export function stripeModeMismatchMessage(modes = getStripeEnvModes()): string {
  const { secret, publishable, expected, aligned } = modes;
  if (!aligned) {
    return `Stripe secret is ${secret}, publishable is ${publishable} — both must be the same mode.`;
  }
  if (secret !== expected) {
    return (
      `This deployment expects Stripe ${expected} keys ` +
      `(got ${secret}). ` +
      (expected === 'live'
        ? 'Set Production STRIPE_SECRET_KEY + NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to sk_live_ / pk_live_ in Vercel and redeploy.'
        : 'Set Staging STRIPE_SECRET_KEY + NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to sk_test_ / pk_test_ in Vercel and redeploy.')
    );
  }
  return '';
}

/** True when this Vercel deployment should hard-fail on wrong Stripe mode. */
export function shouldEnforceStripeMode(): boolean {
  return (
    process.env.VERCEL_ENV === 'production' ||
    process.env.APP_ENV === 'staging' ||
    process.env.VERCEL_GIT_COMMIT_REF === 'staging'
  );
}
