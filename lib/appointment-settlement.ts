import 'server-only';

import { sql } from '@vercel/postgres';

import {
  isAppointmentPaymentKind,
  type AppointmentPaymentKind,
  type TerminalPaymentStatus,
  type TerminalPaymentSummary,
} from '@/app/admin/types';

export interface AppointmentPaymentRow {
  id: string;
  appointment_id: string;
  cal_booking_uid: string | null;
  payment_kind: AppointmentPaymentKind;
  stripe_payment_intent_id: string | null;
  stripe_reader_id: string | null;
  status: TerminalPaymentStatus;
  currency: string;
  base_amount_cents: number;
  tip_amount_cents: number;
  total_amount_cents: number;
  failure_code: string | null;
  failure_message: string | null;
  note: string | null;
  settled_by_email: string | null;
  paid_at: Date | string | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function paymentRowToSummary(
  row: AppointmentPaymentRow
): TerminalPaymentSummary {
  return {
    id: row.id,
    payment_kind: row.payment_kind,
    payment_intent_id: row.stripe_payment_intent_id,
    reader_id: row.stripe_reader_id,
    status: row.status,
    currency: row.currency,
    base_amount_cents: Number(row.base_amount_cents),
    tip_amount_cents: Number(row.tip_amount_cents),
    total_amount_cents: Number(row.total_amount_cents),
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    note: row.note,
    settled_by_email: row.settled_by_email,
    paid_at: serializeDate(row.paid_at),
  };
}

export function isManualSettlementKind(
  kind: AppointmentPaymentKind
): kind is 'cash' | 'complimentary' {
  return kind === 'cash' || kind === 'complimentary';
}

const PAYMENT_SELECT = `
  id,
  appointment_id,
  cal_booking_uid,
  payment_kind,
  stripe_payment_intent_id,
  stripe_reader_id,
  status,
  currency,
  base_amount_cents,
  tip_amount_cents,
  total_amount_cents,
  failure_code,
  failure_message,
  note,
  settled_by_email,
  paid_at
`;

export async function getLatestAppointmentPayment(
  appointmentId: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql.query(
    `SELECT ${PAYMENT_SELECT}
     FROM appointment_payments
     WHERE appointment_id = $1
     ORDER BY
       CASE WHEN status = 'succeeded' THEN 0 ELSE 1 END,
       created_at DESC
     LIMIT 1`,
    [appointmentId]
  );
  const row = rows[0] as AppointmentPaymentRow | undefined;
  return row && isAppointmentPaymentKind(row.payment_kind)
    ? paymentRowToSummary(row)
    : null;
}

export async function getSucceededAppointmentPayment(
  appointmentId: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql.query(
    `SELECT ${PAYMENT_SELECT}
     FROM appointment_payments
     WHERE appointment_id = $1
       AND status = 'succeeded'
     LIMIT 1`,
    [appointmentId]
  );
  const row = rows[0] as AppointmentPaymentRow | undefined;
  return row && isAppointmentPaymentKind(row.payment_kind)
    ? paymentRowToSummary(row)
    : null;
}

export function isSettlementUniqueConflict(err: unknown): boolean {
  const value = err as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    cause?: {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
  };
  const code = value.code ?? value.cause?.code;
  const constraint = value.constraint ?? value.cause?.constraint;
  const message =
    typeof value.message === 'string'
      ? value.message
      : typeof value.cause?.message === 'string'
        ? value.cause.message
        : '';
  return (
    code === '23505' &&
    (constraint === 'appointment_payments_one_succeeded_idx' ||
      message.includes('appointment_payments_one_succeeded_idx'))
  );
}

export async function insertManualSettlement(args: {
  appointmentId: string;
  calBookingUid: string | null;
  kind: 'cash' | 'complimentary';
  baseAmountCents: number;
  note: string | null;
  settledByEmail: string;
}): Promise<TerminalPaymentSummary> {
  const tipAmountCents = 0;
  const totalAmountCents = args.baseAmountCents + tipAmountCents;
  const { rows } = await sql.query(
    `INSERT INTO appointment_payments (
       appointment_id,
       cal_booking_uid,
       payment_kind,
       currency,
       base_amount_cents,
       tip_amount_cents,
       total_amount_cents,
       status,
       note,
       settled_by_email,
       paid_at
     )
     VALUES (
       $1, $2, $3, 'usd', $4, $5, $6, 'succeeded', $7, $8, NOW()
     )
     RETURNING ${PAYMENT_SELECT}`,
    [
      args.appointmentId,
      args.calBookingUid,
      args.kind,
      args.baseAmountCents,
      tipAmountCents,
      totalAmountCents,
      args.note,
      args.settledByEmail,
    ]
  );
  return paymentRowToSummary(rows[0] as AppointmentPaymentRow);
}

export async function undoManualSettlement(
  appointmentId: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql.query(
    `UPDATE appointment_payments
     SET
       status = 'canceled',
       updated_at = NOW()
     WHERE appointment_id = $1
       AND status = 'succeeded'
       AND payment_kind IN ('cash', 'complimentary')
     RETURNING ${PAYMENT_SELECT}`,
    [appointmentId]
  );
  const row = rows[0] as AppointmentPaymentRow | undefined;
  return row ? paymentRowToSummary(row) : null;
}
