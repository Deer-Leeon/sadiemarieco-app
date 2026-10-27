const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTipCents,
  chargeMatchesQuotedTip,
  prepaidKeepAndRefund,
  parseTipDollars,
  tipCentsFromPaymentIntent,
} = require('../../lib/booking-tip.js');

const SERVICE = 10000;

test('percent tips round to the nearest cent and no tip is zero', () => {
  assert.deepEqual(resolveTipCents(SERVICE, 'none'), { ok: true, tipCents: 0 });
  assert.deepEqual(resolveTipCents(SERVICE, '10'), { ok: true, tipCents: 1000 });
  assert.deepEqual(resolveTipCents(SERVICE, '15'), { ok: true, tipCents: 1500 });
  assert.deepEqual(resolveTipCents(SERVICE, '20'), { ok: true, tipCents: 2000 });
  assert.equal(resolveTipCents(999, '15').tipCents, 150);
});

test('custom tip is at least $1 and at most twice the service', () => {
  assert.equal(resolveTipCents(SERVICE, 'custom', 100).ok, true);
  assert.equal(resolveTipCents(SERVICE, 'custom', 20000).ok, true);
  assert.equal(resolveTipCents(SERVICE, 'custom', 99).ok, false);
  assert.equal(resolveTipCents(SERVICE, 'custom', 20001).ok, false);
  assert.equal(resolveTipCents(SERVICE, 'custom', null).ok, false);
  assert.equal(parseTipDollars('12.50'), 1250);
  assert.equal(parseTipDollars(''), null);
});

test('a larger charge with no tip field is not a tip', () => {
  assert.equal(chargeMatchesQuotedTip(SERVICE, SERVICE, 0), true);
  assert.equal(chargeMatchesQuotedTip(SERVICE, 11500, 1500), true);
  assert.equal(chargeMatchesQuotedTip(SERVICE, 11500, 0), false);
  assert.equal(chargeMatchesQuotedTip(SERVICE, 10050, 50), false);
});

test('cancel and no-show refund the tip and keep only a fraction of the service', () => {
  const charged = { chargedCents: 12000, tipCents: 2000 };
  assert.equal(prepaidKeepAndRefund({ ...charged, keepFraction: 0 }).refundAmountCents, 12000);
  const late = prepaidKeepAndRefund({ ...charged, keepFraction: 0.5 });
  assert.equal(late.keepServiceCents, 5000);
  assert.equal(late.refundAmountCents, 7000);
  const missed = prepaidKeepAndRefund({ ...charged, keepFraction: 1 });
  assert.equal(missed.keepServiceCents, 10000);
  assert.equal(missed.refundAmountCents, 2000);
});

test('a prepaid charge with no tip refunds the same way it did before', () => {
  assert.equal(
    prepaidKeepAndRefund({ chargedCents: 10000, keepFraction: 0.5, tipCents: 0 })
      .refundAmountCents,
    5000
  );
  assert.equal(
    prepaidKeepAndRefund({ chargedCents: 10000, keepFraction: 1, tipCents: 0 })
      .refundAmountCents,
    0
  );
  assert.equal(
    prepaidKeepAndRefund({ chargedCents: 10000, keepFraction: 0, tipCents: 0 })
      .refundAmountCents,
    10000
  );
});

test('an online tip is read from metadata when Stripe leaves the tip field empty', () => {
  const intent = {
    amount: 11500,
    amount_details: { tip: {} },
    metadata: { tip_cents: '1500' },
  };
  assert.equal(tipCentsFromPaymentIntent(intent), 1500);
  assert.equal(
    chargeMatchesQuotedTip(SERVICE, intent.amount, tipCentsFromPaymentIntent(intent)),
    true
  );
});

test('a larger charge with neither tip record still does not match', () => {
  const intent = {
    amount: 11500,
    amount_details: { tip: {} },
    metadata: {},
  };
  assert.equal(tipCentsFromPaymentIntent(intent), 0);
  assert.equal(
    chargeMatchesQuotedTip(SERVICE, intent.amount, tipCentsFromPaymentIntent(intent)),
    false
  );
});

test('a reader tip with no metadata still comes from amount_details', () => {
  const intent = {
    amount: 12000,
    amount_details: { tip: { amount: 2000 } },
  };
  assert.equal(tipCentsFromPaymentIntent(intent), 2000);
  assert.equal(
    chargeMatchesQuotedTip(SERVICE, intent.amount, tipCentsFromPaymentIntent(intent)),
    true
  );
});
