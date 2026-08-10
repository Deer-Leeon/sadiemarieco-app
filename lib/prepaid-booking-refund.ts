/**
 * Typed re-export of the CommonJS prepaid refund helper (webhook + admin).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const impl = require('./prepaid-booking-refund.js') as {
  STRIPE_PAYMENT_INTENT_ID_RE: RegExp;
  isPrepaidPayNowAppointment: (row: unknown) => boolean;
  refundPrepaidBooking: (params: {
    paymentIntentId: string;
    keepFraction: number;
    appointmentId?: string | number | null;
    calBookingUid?: string | null;
    reason?: string;
    feeType?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    message?: string;
    skipped?: string;
    paymentIntentId?: string;
    refundId?: string;
    amountCents?: number;
    refundAmountCents?: number;
    keptAmountCents?: number;
    currency?: string;
  }>;
};

export const STRIPE_PAYMENT_INTENT_ID_RE = impl.STRIPE_PAYMENT_INTENT_ID_RE;
export const isPrepaidPayNowAppointment = impl.isPrepaidPayNowAppointment;
export const refundPrepaidBooking = impl.refundPrepaidBooking;
