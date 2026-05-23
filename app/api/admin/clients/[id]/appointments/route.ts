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
import type { ClientAppointment } from '@/app/admin/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AppointmentRow {
  id: string;
  service_name: string | null;
  booking_time: string | null;
  end_time: string | null;
  status: string | null;
}

function rowToAppointment(row: AppointmentRow): ClientAppointment {
  return {
    id: row.id,
    service_name: row.service_name,
    booking_time: row.booking_time,
    end_time: row.end_time,
    status: row.status,
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
    const { rows } = await sql<AppointmentRow>`
      SELECT id, service_name, booking_time, end_time, status
      FROM appointments
      WHERE
            client_id = ${client.id}::uuid
         OR (
              ${client.email}::text IS NOT NULL
              AND client_email IS NOT NULL
              AND LOWER(TRIM(client_email)) = LOWER(TRIM(${client.email}))
            )
         OR (
              ${client.phone}::text IS NOT NULL
              AND client_phone IS NOT NULL
              AND regexp_replace(client_phone, '\D', '', 'g') = ${client.phone}
            )
      ORDER BY booking_time DESC NULLS LAST, id DESC
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
