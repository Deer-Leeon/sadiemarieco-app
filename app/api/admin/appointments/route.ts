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
  client_no_show_flag: boolean | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Same mapper as `app/api/admin/clients/[id]/appointments/route.ts`. */
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
    booking_notes: normalizeStoredBookingNotes(row.booking_notes),
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
    stripe_customer_id: row.stripe_customer_id,
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
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE a.booking_time >= NOW() - INTERVAL '30 days'
      ORDER BY a.booking_time ASC
      LIMIT 1000
    `;

    return NextResponse.json({
      appointments: rows.map(rowToAppointment),
    });
  } catch (err) {
    console.error('[api/admin/appointments] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
