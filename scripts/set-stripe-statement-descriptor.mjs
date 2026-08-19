/**
 * Print (and optionally update) the Stripe account statement descriptor.
 *
 * Card networks currently append support phone + state when no
 * statement_descriptor_suffix is sent, which is why banks showed
 * "sadie Marie +13852003904 Ut". Dashboard prefix should be SADIE
 * (5–10 chars) so statements read SADIE* SADIE MARIE.
 *
 * Dry run (default):
 *   node --env-file=.env.local scripts/set-stripe-statement-descriptor.mjs
 *
 * Apply:
 *   node --env-file=.env.local scripts/set-stripe-statement-descriptor.mjs --apply
 */
import Stripe from 'stripe';

const DESCRIPTOR = 'SADIE MARIE';
const PREFIX = 'SADIE';
const apply = process.argv.includes('--apply');

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error('STRIPE_SECRET_KEY is missing');
  process.exit(1);
}

const stripe = new Stripe(key);
const account = await stripe.accounts.retrieve();

console.log('Account', account.id);
console.log(
  'Current statement descriptor:',
  account.settings?.payments?.statement_descriptor
);
console.log(
  'Current card prefix:',
  account.settings?.card_payments?.statement_descriptor_prefix
);
console.log('Support phone:', account.business_profile?.support_phone);

if (!apply) {
  console.log(
    `\nWould set descriptor=${DESCRIPTOR} prefix=${PREFIX}. Re-run with --apply to write.`
  );
  process.exit(0);
}

const updated = await stripe.accounts.update(account.id, {
  settings: {
    payments: {
      statement_descriptor: DESCRIPTOR,
    },
    card_payments: {
      statement_descriptor_prefix: PREFIX,
    },
  },
});

console.log(
  'Updated statement descriptor:',
  updated.settings?.payments?.statement_descriptor
);
console.log(
  'Updated card prefix:',
  updated.settings?.card_payments?.statement_descriptor_prefix
);
