/**
 * Pure no-show fee math — safe to import from client components.
 * Stripe charging lives in `no-show-charge.ts`.
 */

export const NO_SHOW_PENALTY_FRACTION = 0.5;

export function penaltyAmountCents(servicePriceDollars: number): number {
  if (!Number.isFinite(servicePriceDollars) || servicePriceDollars <= 0) {
    return 0;
  }
  return Math.round(servicePriceDollars * NO_SHOW_PENALTY_FRACTION * 100);
}
