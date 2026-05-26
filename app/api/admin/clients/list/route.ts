/**
 * GET /api/admin/clients/list
 *
 * Full CRM directory for the native iOS admin app (and any other API
 * consumer). Returns the same `Client[]` shape the web directory paints
 * via server-side SQL in `app/admin/clients/page.tsx`.
 *
 * Response (200):
 *   { "clients": Client[] }
 *
 * Search, sort, and pagination stay client-side — mirrors the web
 * `ClientDirectory` rationale (small roster, instant filter).
 *
 * Auth: `requireAdminUser()` — Clerk session (cookie or Bearer JWT) plus
 * the email allowlist in `app/admin/auth.ts`.
 *
 * Note: `GET /api/admin/clients?phone=…` remains the single-client lookup
 * by phone; this route is the roster only.
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Client } from '@/app/admin/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ClientRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: Date | string | null;
  total_bookings: number | string | null;
  lifetime_value: number | string | null;
  has_vaulted_card: boolean | null;
  risk_flag: boolean | null;
  last_booked_at: Date | string | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toNumber(value: number | string | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Same mapper as `app/admin/clients/page.tsx`. */
function rowToClient(row: ClientRow): Client {
  return {
    id: row.id,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    created_at: serializeDate(row.created_at),
    total_bookings: toNumber(row.total_bookings),
    lifetime_value: toNumber(row.lifetime_value),
    has_vaulted_card: Boolean(row.has_vaulted_card),
    risk_flag: Boolean(row.risk_flag),
    last_booked_at: serializeDate(row.last_booked_at),
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
    const { rows } = await sql<ClientRow>`
      SELECT
        c.id,
        c.phone,
        c.first_name,
        c.last_name,
        c.email,
        c.created_at,
        COALESCE(stats.total_bookings, 0)::int AS total_bookings,
        COALESCE(stats.lifetime_value, 0)::float AS lifetime_value,
        COALESCE(stats.has_vaulted_card, FALSE) AS has_vaulted_card,
        COALESCE(stats.risk_flag, FALSE) AS risk_flag,
        stats.last_booked_at
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT
          MAX(a.created_at) AS last_booked_at,
          COUNT(*) FILTER (
            WHERE COALESCE(LOWER(TRIM(a.status)), '') NOT IN (
              'pending',
              'canceled_by_admin',
              'canceled_by_client',
              'canceled_by_client_late',
              'canceled_by_system'
            )
          )::int AS total_bookings,
          COALESCE(
            SUM(
              CASE
                WHEN a.booking_time IS NOT NULL
                  AND a.booking_time < NOW()
                  AND COALESCE(LOWER(TRIM(a.status)), '') IN (
                    'confirmed',
                    'no-show'
                  )
                THEN COALESCE(s.price::numeric, 0)
                ELSE 0
              END
            ),
            0
          )::float AS lifetime_value,
          BOOL_OR(
            a.stripe_customer_id IS NOT NULL
            AND TRIM(a.stripe_customer_id) <> ''
          ) AS has_vaulted_card,
          BOOL_OR(
            COALESCE(LOWER(TRIM(a.status)), '') IN (
              'no-show',
              'canceled_by_client_late'
            )
          ) AS risk_flag
        FROM appointments a
        LEFT JOIN LATERAL (
          SELECT s.price
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
        WHERE
          a.client_id = c.id
          OR (
            c.email IS NOT NULL
            AND a.client_email IS NOT NULL
            AND LOWER(TRIM(a.client_email)) = LOWER(TRIM(c.email))
          )
          OR (
            c.phone IS NOT NULL
            AND a.client_phone IS NOT NULL
            AND regexp_replace(a.client_phone, '\D', '', 'g') = c.phone
          )
      ) stats ON TRUE
      ORDER BY c.first_name ASC NULLS LAST, c.last_name ASC NULLS LAST
    `;

    return NextResponse.json({
      clients: rows.map(rowToClient),
    });
  } catch (err) {
    console.error('[api/admin/clients/list] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
