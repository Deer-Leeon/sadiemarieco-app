/**
 * Post-authorization card checks from Stripe PaymentMethod.card.checks.
 *
 * SetupIntent can still succeed when the issuer approves despite a wrong
 * CVC/ZIP — banks often authorize $0 setups anyway. We reject hard fails
 * ourselves so a vaulted card is more likely to work for later off-session
 * no-show / late-cancel charges.
 *
 * `unavailable` / `unchecked` / null are allowed (issuer didn't run the
 * check — common for some networks/wallets).
 */

/** Stripe types these as `string | null`; we only act on the literal `'fail'`. */
export interface StripeCardChecksLike {
  cvc_check?: string | null;
  address_postal_code_check?: string | null;
  address_line1_check?: string | null;
}

/** Human-readable reason when we must reject the vaulted card. */
export function stripeCardCheckRejection(
  checks: StripeCardChecksLike | null | undefined
): string | null {
  if (!checks) return null;

  if (checks.cvc_check === 'fail') {
    return 'The security code (CVC) did not match this card. Please check the code on the back of your card and try again.';
  }

  if (checks.address_postal_code_check === 'fail') {
    return 'The billing ZIP code did not match this card. Please check your ZIP and try again.';
  }

  return null;
}
