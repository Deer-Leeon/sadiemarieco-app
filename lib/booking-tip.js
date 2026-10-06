/**
 * Optional tip on a pay-now booking. The tip is part of one card charge and
 * is declared separately so it is not stored as service price.
 *
 * CommonJS so the prepaid refund helper can require() the same math.
 */

const TIP_PRESETS = ['none', '10', '15', '20', 'custom'];
const TIP_PERCENTS = [10, 15, 20];
const CUSTOM_TIP_MIN_CENTS = 100;

function isTipPreset(value) {
  return typeof value === 'string' && TIP_PRESETS.includes(value);
}

function percentTipCents(serviceCents, percent) {
  return Math.round((serviceCents * percent) / 100);
}

function customTipMaxCents(serviceCents) {
  return serviceCents * 2;
}

/**
 * @param {number} serviceCents
 * @param {string} preset
 * @param {number | null | undefined} customCents
 * @returns {{ ok: true, tipCents: number } | { ok: false, error: string }}
 */
function resolveTipCents(serviceCents, preset, customCents) {
  if (!Number.isSafeInteger(serviceCents) || serviceCents < 0) {
    return { ok: false, error: 'invalid_service_price' };
  }
  if (preset === 'none') return { ok: true, tipCents: 0 };
  if (preset === '10' || preset === '15' || preset === '20') {
    return { ok: true, tipCents: percentTipCents(serviceCents, Number(preset)) };
  }
  if (preset !== 'custom') return { ok: false, error: 'invalid_tip' };
  if (!Number.isSafeInteger(customCents)) return { ok: false, error: 'invalid_tip' };
  const maxCents = customTipMaxCents(serviceCents);
  if (customCents < CUSTOM_TIP_MIN_CENTS || customCents > maxCents) {
    return { ok: false, error: 'invalid_tip' };
  }
  return { ok: true, tipCents: customCents };
}

function isAllowedTipCents(serviceCents, tipCents) {
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) return false;
  if (resolveTipCents(serviceCents, 'none').tipCents === tipCents) return true;
  for (const percent of TIP_PERCENTS) {
    if (resolveTipCents(serviceCents, String(percent)).tipCents === tipCents) {
      return true;
    }
  }
  return resolveTipCents(serviceCents, 'custom', tipCents).ok === true;
}

/**
 * A pay-now charge is the quoted service plus an allowed tip.
 * A larger charge with no tip field is rejected.
 */
function chargeMatchesQuotedTip(quotedCents, chargedCents, tipCents) {
  if (!Number.isSafeInteger(quotedCents) || quotedCents < 50) return false;
  if (!Number.isSafeInteger(chargedCents) || !Number.isSafeInteger(tipCents)) {
    return false;
  }
  if (tipCents < 0 || chargedCents !== quotedCents + tipCents) return false;
  return isAllowedTipCents(quotedCents, tipCents);
}

function tipCentsFromAmountDetails(amountDetails) {
  const raw =
    amountDetails && amountDetails.tip ? amountDetails.tip.amount : 0;
  const tip = Number(raw || 0);
  if (!Number.isSafeInteger(tip) || tip < 0) return 0;
  return tip;
}

/**
 * Keep fraction applies to the service only. The tip is always refunded.
 * A legacy charge with no tip uses the same math as before.
 *
 * @param {{
 *   chargedCents: number,
 *   alreadyRefunded?: number,
 *   keepFraction: number,
 *   tipCents?: number,
 * }} params
 */
function prepaidKeepAndRefund(params) {
  const chargedCents = Number(params.chargedCents);
  const alreadyRefunded = Math.max(0, Number(params.alreadyRefunded || 0));
  const keepFraction = Number(params.keepFraction);
  const reportedTip = Math.max(0, Number(params.tipCents || 0));
  const tipCents = Math.min(reportedTip, chargedCents);
  const serviceCents = chargedCents - tipCents;
  const keepServiceCents = Math.round(serviceCents * keepFraction);
  const desiredRefund = Math.max(0, chargedCents - keepServiceCents);
  const refundable = Math.max(0, chargedCents - alreadyRefunded);
  const refundAmountCents = Math.min(refundable, desiredRefund);
  return {
    tipCents,
    serviceCents,
    keepServiceCents,
    refundAmountCents,
    keptAmountCents: chargedCents - alreadyRefunded - refundAmountCents,
  };
}

/** Dollars typed in the tip field → cents. Empty or junk is null. */
function parseTipDollars(raw) {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/^\$/, '');
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

module.exports = {
  TIP_PRESETS,
  TIP_PERCENTS,
  CUSTOM_TIP_MIN_CENTS,
  isTipPreset,
  percentTipCents,
  customTipMaxCents,
  resolveTipCents,
  isAllowedTipCents,
  chargeMatchesQuotedTip,
  tipCentsFromAmountDetails,
  prepaidKeepAndRefund,
  parseTipDollars,
};
