import type { Appointment } from '@/app/admin/types';
import { nestAttachedExtras } from '@/lib/appointment-extras';
import { mapSqlPaymentFields } from '@/lib/appointment-payment-sql';
import { clientBookingNotesForDisplay } from '@/lib/cal-booking-notes';
import {
  applyCatalogueService,
  type CatalogueServiceRow,
} from '@/lib/match-catalogue-service';

export interface AdminAppointmentSqlRow {
  id: string;
  cal_event_id: string | null;
  attached_to_appointment_id: string | null;
  cal_event_type_id: number | null;
  service_slug: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  chair_duration_mins?: number | null;
  catalogue_duration_mins?: number | null;
  service_name: string | null;
  status: string | null;
  client_phone: string | null;
  client_email: string | null;
  booking_notes: string | null;
  service_price: string | number | null;
  service_description: string | null;
  service_color: string | null;
  stripe_customer_id: string | null;
  terminal_payment_id: string | null;
  terminal_payment_kind: string | null;
  terminal_payment_intent_id: string | null;
  terminal_reader_id: string | null;
  terminal_payment_status: string | null;
  terminal_currency: string | null;
  terminal_base_amount_cents: number | null;
  terminal_tip_amount_cents: number | null;
  terminal_total_amount_cents: number | null;
  terminal_failure_code: string | null;
  terminal_failure_message: string | null;
  terminal_note: string | null;
  terminal_settled_by_email: string | null;
  terminal_paid_at: Date | string | null;
  client_no_show_flag: boolean | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function mapAdminAppointmentRow(
  row: AdminAppointmentSqlRow,
  catalogue: CatalogueServiceRow[]
): Appointment {
  const catalogueFields = applyCatalogueService(row, catalogue);
  const priceNum =
    row.service_price === null || row.service_price === undefined
      ? NaN
      : Number(row.service_price);
  return {
    id: String(row.id),
    cal_uid: row.cal_event_id,
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    booking_time: serializeDate(row.booking_time),
    end_time: serializeDate(row.end_time),
    chair_duration_mins: toPositiveInt(row.chair_duration_mins),
    catalogue_duration_mins:
      toPositiveInt(row.catalogue_duration_mins) ??
      catalogueFields.duration_mins,
    service_name: catalogueFields.service_name,
    status: row.status,
    client_phone: row.client_phone,
    client_email: row.client_email,
    booking_notes: clientBookingNotesForDisplay(
      row.booking_notes,
      catalogueFields.service_description
    ),
    service_price: Number.isFinite(priceNum) ? priceNum : null,
    service_description: catalogueFields.service_description,
    service_slug: catalogueFields.service_slug,
    service_color: catalogueFields.service_color,
    stripe_customer_id: row.stripe_customer_id,
    terminal_payment: mapSqlPaymentFields(row),
    client_no_show_flag: Boolean(row.client_no_show_flag),
    attached_to_appointment_id: row.attached_to_appointment_id
      ? String(row.attached_to_appointment_id)
      : null,
    extras: [],
    extra_count: 0,
  };
}

export function mapAndNestAdminAppointments(
  rows: AdminAppointmentSqlRow[],
  catalogue: CatalogueServiceRow[]
): Appointment[] {
  return nestAttachedExtras(
    rows.map((row) => mapAdminAppointmentRow(row, catalogue))
  );
}
