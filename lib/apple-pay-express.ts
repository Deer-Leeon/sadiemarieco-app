/**
 * Apple Pay / Express Checkout helpers.
 *
 * Stripe's wallet sheet can show Face ID success while our server still
 * rejects the vaulted card (wrong ZIP on a $0 SetupIntent). After that,
 * Express Checkout is "done" and will not start a new confirm for a
 * different card until the element is remounted.
 */

export function applePayFriendlyError(error: {
  message?: string;
} | string | null | undefined): string {
  const msg = (
    typeof error === 'string' ? error : error?.message || ''
  ).trim();
  if (/zip|postal/i.test(msg)) {
    return 'That card’s billing ZIP in Apple Pay does not match the card. Choose a different card, update the ZIP in Wallet, or pay with card.';
  }
  if (/cvc|security code/i.test(msg)) {
    return 'That card’s security code did not match. Choose a different card in Apple Pay or pay with card.';
  }
  if (msg) return msg;
  return 'Apple Pay could not complete. Please try again or pay with card.';
}
