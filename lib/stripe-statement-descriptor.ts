/**
 * Card-statement merchant name. Banks cap this at 22 characters.
 * Account-level Stripe "Public details" must match — otherwise the
 * dashboard descriptor (name + phone + state) is what clients see.
 */
export const STRIPE_STATEMENT_DESCRIPTOR = 'SADIE MARIE';

/** Card prefix is 5–10 chars. Used with statement_descriptor_suffix. */
export const STRIPE_STATEMENT_DESCRIPTOR_PREFIX = 'SADIE';

/** Fields for card PaymentIntents (online + Apple Pay). */
export const stripeCardStatementFields = {
  statement_descriptor_suffix: STRIPE_STATEMENT_DESCRIPTOR,
} as const;

/** Fields for Terminal / card_present PaymentIntents. */
export const stripeCardPresentStatementFields = {
  statement_descriptor: STRIPE_STATEMENT_DESCRIPTOR,
} as const;
