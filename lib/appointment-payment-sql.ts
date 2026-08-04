import type {
  AppointmentPaymentKind,
  TerminalPaymentStatus,
  TerminalPaymentSummary,
} from '@/app/admin/types';
import { isAppointmentPaymentKind } from '@/app/admin/types';

export interface AppointmentPaymentSqlFields {
  terminal_payment_id: string | null;
  terminal_payment_kind: string | null;
  terminal_payment_intent_id: string | null;
  terminal_reader_id: string | null;
  terminal_payment_status: string | null;
  terminal_currency: string | null;
  terminal_base_amount_cents: number | string | null;
  terminal_tip_amount_cents: number | string | null;
  terminal_total_amount_cents: number | string | null;
  terminal_failure_code: string | null;
  terminal_failure_message: string | null;
  terminal_note: string | null;
  terminal_settled_by_email: string | null;
  terminal_paid_at: Date | string | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const STATUSES = new Set<TerminalPaymentStatus>([
  'pending',
  'processing',
  'succeeded',
  'failed',
  'canceled',
]);

export function mapSqlPaymentFields(
  row: AppointmentPaymentSqlFields
): TerminalPaymentSummary | null {
  if (
    !row.terminal_payment_id ||
    !row.terminal_payment_status ||
    !STATUSES.has(row.terminal_payment_status as TerminalPaymentStatus) ||
    !isAppointmentPaymentKind(row.terminal_payment_kind)
  ) {
    return null;
  }

  return {
    id: row.terminal_payment_id,
    payment_kind: row.terminal_payment_kind as AppointmentPaymentKind,
    payment_intent_id: row.terminal_payment_intent_id,
    reader_id: row.terminal_reader_id,
    status: row.terminal_payment_status as TerminalPaymentStatus,
    currency: row.terminal_currency || 'usd',
    base_amount_cents: Number(row.terminal_base_amount_cents || 0),
    tip_amount_cents: Number(row.terminal_tip_amount_cents || 0),
    total_amount_cents: Number(row.terminal_total_amount_cents || 0),
    failure_code: row.terminal_failure_code,
    failure_message: row.terminal_failure_message,
    note: row.terminal_note,
    settled_by_email: row.terminal_settled_by_email,
    paid_at: serializeDate(row.terminal_paid_at),
  };
}
