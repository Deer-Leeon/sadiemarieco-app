/**
 * Pure no-show fee math — safe to import from client components.
 * Stripe charging lives in `no-show-charge.ts`.
 */

/** Full service price. Kept as a named fraction so UI/docs can render the %. */
export const NO_SHOW_PENALTY_FRACTION = 1;

export function penaltyAmountCents(servicePriceDollars: number): number {
  if (!Number.isFinite(servicePriceDollars) || servicePriceDollars <= 0) {
    return 0;
  }
  return Math.round(servicePriceDollars * NO_SHOW_PENALTY_FRACTION * 100);
}
