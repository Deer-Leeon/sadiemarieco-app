import type { Appointment, TerminalPaymentSummary } from '@/app/admin/types';
import { isAppointmentSettled } from '@/app/admin/settlementDisplay';

/** True when this row is catalogue work nested under a calendar visit. */
export function isAttachedExtra(
  appointment: Pick<Appointment, 'attached_to_appointment_id'>
): boolean {
  return Boolean(appointment.attached_to_appointment_id);
}

/**
 * Fold child extras onto their parent visit and drop them from the
 * top-level list so calendar / history never treat extras as their own
 * bookings.
 */
export function nestAttachedExtras(appointments: Appointment[]): Appointment[] {
  const extrasByParent = new Map<string, Appointment[]>();
  const parents: Appointment[] = [];

  for (const appointment of appointments) {
    const parentId = appointment.attached_to_appointment_id;
    if (parentId) {
      const list = extrasByParent.get(parentId) ?? [];
      list.push({
        ...appointment,
        extras: [],
        extra_count: 0,
      });
      extrasByParent.set(parentId, list);
    } else {
      parents.push(appointment);
    }
  }

  return parents.map((parent) => {
    const extras = extrasByParent.get(parent.id) ?? parent.extras ?? [];
    return {
      ...parent,
      extras,
      extra_count: extras.length,
    };
  });
}

export function extraDuringVisitLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 extra during this visit.'
    : `${count} extras during this visit.`;
}

export function appointmentQuotedCents(
  appointment: Pick<Appointment, 'service_price'>
): number {
  if (appointment.service_price == null) return 0;
  const cents = Math.round(appointment.service_price * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
}

export function unpaidExtras(appointment: Appointment): Appointment[] {
  return (appointment.extras ?? []).filter(
    (extra) =>
      (extra.status || '').toLowerCase() === 'confirmed' &&
      !isAppointmentSettled(extra.terminal_payment)
  );
}

export function withPatchedPayments(
  appointment: Appointment,
  ids: string[],
  payment: TerminalPaymentSummary | null,
  payments?: TerminalPaymentSummary[] | null
): Appointment {
  const paymentFor = (id: string) => {
    const grouped = payments?.find(
      (row) => row.appointment_id === id && row.status === 'succeeded'
    );
    if (grouped) return grouped;
    if (ids.includes(id)) return payment;
    return undefined;
  };
  const nextPayment = paymentFor(appointment.id);
  const extras = (appointment.extras ?? []).map((extra) => {
    const extraPayment = paymentFor(extra.id);
    return extraPayment !== undefined
      ? { ...extra, terminal_payment: extraPayment }
      : extra;
  });
  return {
    ...appointment,
    ...(nextPayment !== undefined ? { terminal_payment: nextPayment } : {}),
    extras,
    extra_count: extras.length,
  };
}
