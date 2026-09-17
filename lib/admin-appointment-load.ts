import 'server-only';

import { sql } from '@vercel/postgres';

import type { Appointment } from '@/app/admin/types';
import {
  mapAndNestAdminAppointments,
  type AdminAppointmentSqlRow,
} from '@/lib/admin-appointment-map';
import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import { loadActiveCatalogueServices } from '@/lib/match-catalogue-service';
import { ensureChairDurationSchema } from '@/lib/visit-duration';

export async function loadVisitAppointment(
  parentId: string
): Promise<Appointment | null> {
  await ensureAppointmentAttachedSchema();
  await ensureChairDurationSchema();
  const [{ rows }, catalogue] = await Promise.all([
    sql<AdminAppointmentSqlRow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.attached_to_appointment_id,
        a.cal_event_type_id,
        a.client_first_name,
        a.client_last_name,
        a.booking_time,
        a.end_time,
        a.chair_duration_mins,
        a.service_name,
        a.status,
        a.client_phone,
        a.client_email,
        a.stripe_customer_id,
        a.booking_notes,
        COALESCE(
          (
            SELECT c.no_show_flag
            FROM clients c
            WHERE a.client_id IS NOT NULL
              AND c.id = a.client_id
            LIMIT 1
          ),
          FALSE
        ) AS client_no_show_flag,
        a.quoted_service_price_cents::numeric / 100 AS service_price,
        s.description AS service_description,
        s.slug        AS service_slug,
        s.color       AS service_color,
        s.duration_mins AS catalogue_duration_mins,
        pay.id AS terminal_payment_id,
        pay.payment_kind AS terminal_payment_kind,
        pay.stripe_payment_intent_id AS terminal_payment_intent_id,
        pay.stripe_reader_id AS terminal_reader_id,
        pay.status AS terminal_payment_status,
        pay.currency AS terminal_currency,
        pay.base_amount_cents AS terminal_base_amount_cents,
        pay.tip_amount_cents AS terminal_tip_amount_cents,
        pay.total_amount_cents AS terminal_total_amount_cents,
        pay.failure_code AS terminal_failure_code,
        pay.failure_message AS terminal_failure_message,
        pay.note AS terminal_note,
        pay.settled_by_email AS terminal_settled_by_email,
        pay.paid_at AS terminal_paid_at
      FROM appointments a
      LEFT JOIN LATERAL (
        SELECT s.price, s.description, s.slug, s.color, s.duration_mins
        FROM site_services s
        WHERE s.is_active = TRUE
          AND (
            (
              a.cal_event_type_id IS NOT NULL
              AND s.cal_event_id = a.cal_event_type_id
            )
            OR (
              a.cal_event_type_id IS NULL
              AND s.title = split_part(a.service_name, ' between ', 1)
            )
          )
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          p.id,
          p.payment_kind,
          p.stripe_payment_intent_id,
          p.stripe_reader_id,
          p.status,
          p.currency,
          p.base_amount_cents,
          p.tip_amount_cents,
          p.total_amount_cents,
          p.failure_code,
          p.failure_message,
          p.note,
          p.settled_by_email,
          p.paid_at
        FROM appointment_payments p
        WHERE p.appointment_id = a.id::text
        ORDER BY
          CASE WHEN p.status = 'succeeded' THEN 0 ELSE 1 END,
          p.created_at DESC
        LIMIT 1
      ) pay ON TRUE
      WHERE a.id::text = ${parentId}
         OR a.attached_to_appointment_id::text = ${parentId}
      ORDER BY a.attached_to_appointment_id NULLS FIRST, a.booking_time ASC
    `,
    loadActiveCatalogueServices(),
  ]);

  const nested = mapAndNestAdminAppointments(rows, catalogue);
  return nested.find((row) => row.id === parentId) ?? nested[0] ?? null;
}
