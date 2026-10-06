/**
 * Typed re-export of the pay-now tip math (checkout, PaymentIntent, refunds).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const impl = require('./booking-tip.js') as {
  TIP_PRESETS: readonly ['none', '10', '15', '20', 'custom'];
  TIP_PERCENTS: readonly number[];
  CUSTOM_TIP_MIN_CENTS: number;
  isTipPreset: (value: unknown) => value is TipPreset;
  percentTipCents: (serviceCents: number, percent: number) => number;
  customTipMaxCents: (serviceCents: number) => number;
  resolveTipCents: (
    serviceCents: number,
    preset: string,
    customCents?: number | null
  ) => { ok: true; tipCents: number } | { ok: false; error: string };
  isAllowedTipCents: (serviceCents: number, tipCents: number) => boolean;
  chargeMatchesQuotedTip: (
    quotedCents: number,
    chargedCents: number,
    tipCents: number
  ) => boolean;
  tipCentsFromAmountDetails: (amountDetails: unknown) => number;
  prepaidKeepAndRefund: (params: {
    chargedCents: number;
    alreadyRefunded?: number;
    keepFraction: number;
    tipCents?: number;
  }) => {
    tipCents: number;
    serviceCents: number;
    keepServiceCents: number;
    refundAmountCents: number;
    keptAmountCents: number;
  };
  parseTipDollars: (raw: string) => number | null;
};

export type TipPreset = 'none' | '10' | '15' | '20' | 'custom';

export const TIP_PRESETS = impl.TIP_PRESETS;
export const TIP_PERCENTS = impl.TIP_PERCENTS;
export const CUSTOM_TIP_MIN_CENTS = impl.CUSTOM_TIP_MIN_CENTS;
export const isTipPreset = impl.isTipPreset;
export const percentTipCents = impl.percentTipCents;
export const customTipMaxCents = impl.customTipMaxCents;
export const resolveTipCents = impl.resolveTipCents;
export const isAllowedTipCents = impl.isAllowedTipCents;
export const chargeMatchesQuotedTip = impl.chargeMatchesQuotedTip;
export const tipCentsFromAmountDetails = impl.tipCentsFromAmountDetails;
export const prepaidKeepAndRefund = impl.prepaidKeepAndRefund;
export const parseTipDollars = impl.parseTipDollars;

export function tipRequestBody(
  preset: TipPreset,
  customCents: number | null
): { tipPreset: TipPreset; tipCents?: number } {
  if (preset === 'custom') {
    return { tipPreset: 'custom', tipCents: customCents ?? undefined };
  }
  return { tipPreset: preset };
}
