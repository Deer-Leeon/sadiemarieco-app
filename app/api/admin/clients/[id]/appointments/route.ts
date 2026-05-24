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
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Appointment } from '@/app/admin/types';

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
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function rowToAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    cal_uid: row.cal_event_id,
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    booking_time: serializeDate(row.booking_time),
    end_time: serializeDate(row.end_time),
    service_name: row.service_name,
    status: row.status,
    client_phone: row.client_phone,
    client_email: row.client_email,
    service_price:
      row.service_price === null
        ? null
        : (() => {
            const n = Number(row.service_price);
            return Number.isFinite(n) ? n : null;
          })(),
    service_description: row.service_description,
    service_slug: row.service_slug,
    service_color: row.service_color,
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
    // LEFT JOIN LATERAL (LIMIT 1) instead of a plain equality LEFT JOIN
    // — site_services can hold multiple rows with the same title
    // ("Classic" / "Hybrid" / "Volume" live as children under each of
    // the 2-/3-/4-Week Fill groups), and a plain join would multiply
    // every appointment row by the match count. That bug manifests as
    // (1) duplicate React keys in the appointment-history list, and
    // (2) the same booking appearing 2–3× in a client's history.
    // Picking the most-recently-touched match keeps the price / slug
    // we surface as fresh as possible without dragging the wrong row.
    const { rows } = await sql<AppointmentRow>`
      SELECT
        a.id,
        a.cal_event_id,
        a.client_first_name,
        a.client_last_name,
        a.booking_time,
        a.end_time,
        a.service_name,
        a.status,
        a.client_phone,
        a.client_email,
        s.price       AS service_price,
        s.description AS service_description,
        s.slug        AS service_slug,
        s.color       AS service_color
      FROM appointments a
      LEFT JOIN LATERAL (
        SELECT s.price, s.description, s.slug, s.color
        FROM site_services s
        WHERE s.title = split_part(a.service_name, ' between ', 1)
          AND s.is_active = TRUE
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE
            a.client_id = ${client.id}::uuid
         OR (
              ${client.email}::text IS NOT NULL
              AND a.client_email IS NOT NULL
              AND LOWER(TRIM(a.client_email)) = LOWER(TRIM(${client.email}))
            )
         OR (
              ${client.phone}::text IS NOT NULL
              AND a.client_phone IS NOT NULL
              AND regexp_replace(a.client_phone, '\D', '', 'g') = ${client.phone}
            )
      ORDER BY a.booking_time DESC NULLS LAST, a.id DESC
      LIMIT 500
    `;
    return NextResponse.json({ appointments: rows.map(rowToAppointment) });
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
