/**
 * GET /api/admin/appointments
 *
 * Bookings dashboard payload for the native iOS admin app (and any other
 * API consumer). Returns the same `Appointment[]` shape the web dashboard
 * paints via server-side SQL in `app/admin/page.tsx`, so List / calendar
 * views can share one wire contract.
 *
 * Response (200):
 *   { "appointments": Appointment[] }
 *
 * Auth: `requireAdminUser()` — Clerk session (cookie or Bearer JWT) plus
 * the email allowlist in `app/admin/auth.ts`. Same pattern as
 * `/api/admin/clients/[id]/appointments` and `/api/admin/services`.
 *
 * Query window: last 30 days through all future rows, capped at 1000 —
 * mirrors `app/admin/page.tsx` exactly. Client-side filtering (e.g.
 * hiding canceled statuses for the list view) stays in the iOS app,
 * matching `DashboardUI.tsx`.
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Appointment } from '@/app/admin/types';
import { normalizeStoredBookingNotes } from '@/lib/cal-booking-notes';
import { mapSqlPaymentFields } from '@/lib/appointment-payment-sql';
import {
  applyCatalogueService,
  loadActiveCatalogueServices,
  type CatalogueServiceRow,
} from '@/lib/match-catalogue-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Row shape from Postgres — mirrors `app/admin/page.tsx` DbRow and
 * `app/api/admin/clients/[id]/appointments/route.ts` AppointmentRow.
 */
interface AppointmentRow {
  id: string;
  cal_event_id: string | null;
  cal_event_type_id: number | null;
  service_slug: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  service_name: string | null;
  status: string | null;
  client_phone: string | null;
  client_email: string | null;
  booking_notes: string | null;
  service_price: string | null;
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

/** Same mapper as `app/api/admin/clients/[id]/appointments/route.ts`. */
function rowToAppointment(
  row: AppointmentRow,
  catalogue: CatalogueServiceRow[],
): Appointment {
  const catalogueFields = applyCatalogueService(row, catalogue);
  return {
    id: row.id,
    cal_uid: row.cal_event_id,
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    booking_time: serializeDate(row.booking_time),
    end_time: serializeDate(row.end_time),
    service_name: catalogueFields.service_name,
    status: row.status,
    client_phone: row.client_phone,
    client_email: row.client_email,
    booking_notes: normalizeStoredBookingNotes(row.booking_notes),
    service_price:
      row.service_price === null
        ? null
        : (() => {
            const n = Number(row.service_price);
            return Number.isFinite(n) ? n : null;
          })(),
    service_description: catalogueFields.service_description,
    service_slug: catalogueFields.service_slug,
    service_color: catalogueFields.service_color,
    stripe_customer_id: row.stripe_customer_id,
    terminal_payment: mapSqlPaymentFields(row),
    client_no_show_flag: Boolean(row.client_no_show_flag),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  try {
    const [{ rows }, catalogue] = await Promise.all([
      sql<AppointmentRow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.cal_event_type_id,
        a.client_first_name,
        a.client_last_name,
        a.booking_time,
        a.end_time,
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
          (
            SELECT c.no_show_flag
            FROM clients c
            WHERE a.client_id IS NULL
              AND a.client_phone IS NOT NULL
              AND c.phone IS NOT NULL
              AND (
                regexp_replace(a.client_phone, '\D', '', 'g') = c.phone
                OR (
                  length(c.phone) = 11
                  AND left(c.phone, 1) = '1'
                  AND regexp_replace(a.client_phone, '\D', '', 'g') = substr(c.phone, 2)
                )
                OR (
                  length(c.phone) = 10
                  AND regexp_replace(a.client_phone, '\D', '', 'g') = '1' || c.phone
                )
              )
            ORDER BY c.created_at DESC NULLS LAST
            LIMIT 1
          ),
          FALSE
        ) AS client_no_show_flag,
        a.quoted_service_price_cents::numeric / 100 AS service_price,
        s.description AS service_description,
        s.slug        AS service_slug,
        s.color       AS service_color,
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
        SELECT s.price, s.description, s.slug, s.color
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
              AND (
                lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
                  'classic', 'hybrid', 'volume'
                )
                OR (
                  a.booking_time IS NOT NULL
                  AND a.end_time IS NOT NULL
                  AND s.duration_mins IS NOT NULL
                  AND s.duration_mins = GREATEST(
                    1,
                    ROUND(
                      EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                    )
                  )::integer
                )
              )
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
      WHERE a.booking_time >= NOW() - INTERVAL '30 days'
      ORDER BY a.booking_time ASC
      LIMIT 1000
    `,
      loadActiveCatalogueServices(),
    ]);

    return NextResponse.json({
      appointments: rows.map((row) => rowToAppointment(row, catalogue)),
    });
  } catch (err) {
    console.error('[api/admin/appointments] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
