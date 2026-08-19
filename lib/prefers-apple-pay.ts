/**
 * Apple Pay is offered when the browser exposes ApplePaySession
 * (typically Safari/Chrome on a Mac or iPhone with a card in Wallet).
 * Windows has no ApplePaySession, so this returns false — do not UA-sniff.
 * Stripe Express Checkout `onReady` is still the source of truth for
 * whether the Apple Pay button can actually render.
 */
export function prefersApplePayDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const AP = (
      window as Window & {
        ApplePaySession?: { canMakePayments?: () => boolean };
      }
    ).ApplePaySession;
    if (!AP || typeof AP.canMakePayments !== 'function') return false;
    return AP.canMakePayments();
  } catch {
    return false;
  }
}
