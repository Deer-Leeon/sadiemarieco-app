import type {
  AppointmentPaymentKind,
  TerminalPaymentSummary,
} from './types';

/** True when the appointment has a successful settlement (card, cash, or comp). */
export function isAppointmentSettled(
  payment: TerminalPaymentSummary | null | undefined
): boolean {
  return payment?.status === 'succeeded';
}

/**
 * Compact calendar/list label. Keep these short — month and week cells
 * have almost no horizontal room.
 */
export function settlementShortLabel(
  kind: AppointmentPaymentKind | null | undefined
): 'Paid' | 'Cash' | 'Comped' {
  if (kind === 'cash') return 'Cash';
  if (kind === 'complimentary') return 'Comped';
  return 'Paid';
}

export function settlementAriaLabel(
  payment: TerminalPaymentSummary | null | undefined
): string | null {
  if (!isAppointmentSettled(payment)) return null;
  return settlementShortLabel(payment?.payment_kind);
}
