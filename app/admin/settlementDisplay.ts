import type { TerminalPaymentSummary } from './types';

/** True when the appointment has a successful settlement (card, cash, or comp). */
export function isAppointmentSettled(
  payment: TerminalPaymentSummary | null | undefined
): boolean {
  return payment?.status === 'succeeded';
}

export function isOnlinePrepaidPayment(
  payment: TerminalPaymentSummary | null | undefined
): boolean {
  return Boolean(
    payment &&
      payment.status === 'succeeded' &&
      payment.payment_kind === 'service_payment' &&
      !payment.reader_id &&
      payment.payment_intent_id
  );
}

/**
 * Compact calendar/list label. Keep these short — month and week cells
 * have almost no horizontal room.
 */
export function settlementShortLabel(
  payment: TerminalPaymentSummary | null | undefined
): 'Paid' | 'Cash' | 'Comped' | 'Online' {
  if (payment?.payment_kind === 'cash') return 'Cash';
  if (payment?.payment_kind === 'complimentary') return 'Comped';
  if (isOnlinePrepaidPayment(payment)) return 'Online';
  return 'Paid';
}

export function settlementAriaLabel(
  payment: TerminalPaymentSummary | null | undefined
): string | null {
  if (!isAppointmentSettled(payment)) return null;
  return settlementShortLabel(payment);
}
