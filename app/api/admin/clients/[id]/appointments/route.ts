/**
 * /api/admin/clients/[id]/appointments
 *
 * Per-client booking history. Returns every appointment we can
 * attribute to this client by THREE independent matchers, OR'd
 * together so a client booked under different email addresses still
 * shows up:
 *
 *   1. appointments.client_id = clients.id
 *        — the FK that the webhook populates on BOOKING_CREATED.
 *          Most reliable for post-CRM bookings.
 *
 *   2. lower(trim(appointments.client_email)) = lower(trim(clients.email))
 *        — covers legacy bookings made before the CRM existed where
 *          client_id might be NULL or point at a different (now
 *          legacy) clients row.
 *
 *   3. regexp_replace(appointments.client_phone, '\D', '', 'g') = clients.phone
 *        — covers bookings where the client used a different email
 *          but the same phone number. Phone is our canonical
 *          identifier per the CRM contract, so it's the strongest
 *          dedupe signal.
 *
 * Returns a flat list ordered booking_time DESC NULLS LAST so the
 * most recent / upcoming appointments are at the top of the modal.
 *
 * Rows with status `pending` are excluded: those are Cal holds created
 * when a client picked a slot but has not finished Stripe checkout.
 * They belong on the admin List view ("Awaiting Payment"), not in this
 * client's booking history.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Appointment } from '@/app/admin/types';
import { nestAttachedExtras } from '@/lib/appointment-extras';
import { clientBookingNotesForDisplay } from '@/lib/cal-booking-notes';
import { fetchClientCrmStats } from '@/lib/client-crm-stats';
import { sqlPhoneVariants } from '@/lib/client-identity';
import { mapSqlPaymentFields } from '@/lib/appointment-payment-sql';
import {
  applyCatalogueService,
  loadActiveCatalogueServices,
  type CatalogueServiceRow,
} from '@/lib/match-catalogue-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Row shape mirrors what the dashboard's main appointments query in
 * `app/admin/page.tsx` returns. We pull the same superset of fields
 * so a row clicked here can be dropped straight into the existing
 * `<AppointmentModal />` (cancel / no-show / reschedule) without an
 * extra round-trip to re-enrich it.
 */
interface AppointmentRow {
  id: string;
  // appointments.cal_event_id — actually stores the Cal.com booking
  // UID. Surfaced as `cal_uid` on the wire to match the type.
  cal_event_id: string | null;
  attached_to_appointment_id: string | null;
  cal_event_type_id: number | null;
  // site_services.slug — joined in below. Required by the reschedule
  // embed; the cancel/no-show paths don't need it.
  service_slug: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  // TIMESTAMPTZ arrives as Date in some environments, ISO string in
  // others. We normalise both to ISO string below.
  booking_time: Date | string | null;
  end_time: Date | string | null;
  service_name: string | null;
  status: string | null;
  client_phone: string | null;
  client_email: string | null;
  // NUMERIC arrives stringified — coerced to number below.
  service_price: string | null;
  service_description: string | null;
  // Editor-assigned hex from site_services.color; null = "no override,
  // fall back to the auto-matcher" — see app/admin/serviceColors.ts.
  service_color: string | null;
  // Stripe Customer id (`cus_…`) for the vaulted card-on-file. Written
  // by /api/booking/confirm after a successful SetupIntent on /checkout.
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
  booking_notes: string | null;
  client_no_show_flag: boolean | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

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
    booking_notes: clientBookingNotesForDisplay(
      row.booking_notes,
      catalogueFields.service_description
    ),
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
    attached_to_appointment_id: row.attached_to_appointment_id
      ? String(row.attached_to_appointment_id)
      : null,
    extras: [],
    extra_count: 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(
  _req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    // Resolve the client first so we have the canonical email/phone
    // to match on. A non-existent UUID returns 404.
    const { rows: clientRows } = await sql<{
      id: string;
      email: string | null;
      phone: string | null;
    }>`
      SELECT id, email, phone
      FROM clients
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    if (clientRows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const client = clientRows[0];
    const [phoneV0, phoneV1] = client.phone
      ? sqlPhoneVariants(client.phone)
      : ['', ''];

    // Three-way OR match. We pass NULL-fallbacks for the email/phone
    // comparison values so the SQL stays well-typed when the client
    // row has one of them blank. Postgres' NULL semantics mean
    // `LOWER(...) = NULL` is NULL (falsy), so a missing email on
    // either side just falls through to the other matchers.
    //
    // LEFT JOIN to site_services mirrors the dashboard's main
    // appointments query (see `app/admin/page.tsx`) so rows pulled
    // here are immediately usable in <AppointmentModal /> without a
    // second roundtrip. The JOIN is on the cleaned service title
    // (Cal.com pads it with "between …" suffixes) and filters to
    // active services so a soft-deleted CMS row doesn't keep
    // enriching new appointments after it's been retired.
    // LEFT JOIN LATERAL (LIMIT 1) — same disambiguation as the dashboard
    // query in `app/admin/page.tsx`: bare fill titles ("Classic" /
    // "Hybrid" / "Volume") also require matching appointment duration
    // to the child's duration_mins so 2-/3-/4-week fills keep distinct
    // editor-assigned colours.
    const [{ rows }, catalogue] = await Promise.all([
      sql<AppointmentRow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.attached_to_appointment_id,
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
        FALSE AS client_no_show_flag,
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
      WHERE
            (
              a.client_id = ${client.id}::uuid
           OR (
                ${client.email}::text IS NOT NULL
                AND a.client_email IS NOT NULL
                AND LOWER(TRIM(a.client_email)) = LOWER(TRIM(${client.email}))
              )
           OR (
                ${client.phone}::text IS NOT NULL
                AND a.client_phone IS NOT NULL
                AND (
                  regexp_replace(a.client_phone, '\D', '', 'g') = ${phoneV0}
                  OR regexp_replace(a.client_phone, '\D', '', 'g') = ${phoneV1}
                )
              )
            )
        AND COALESCE(LOWER(TRIM(a.status)), '') <> 'pending'
      ORDER BY a.booking_time DESC NULLS LAST, a.id DESC
      LIMIT 500
    `,
      loadActiveCatalogueServices(),
    ]);
    const crm_stats = await fetchClientCrmStats(client.id, {
      email: client.email,
      phone: client.phone,
    });

    return NextResponse.json({
      appointments: nestAttachedExtras(
        rows.map((row) =>
          rowToAppointment(
            {
              ...row,
              client_no_show_flag: crm_stats.no_show_flag,
            },
            catalogue,
          )
        )
      ),
      crm_stats,
    });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/appointments] GET failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
