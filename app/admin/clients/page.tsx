/**
 * /admin/clients — top-level CRM directory.
 *
 * Server component that loads the entire `clients` table on every
 * request (force-dynamic, no cache) and hands it to the interactive
 * `<ClientDirectory />` for the search + list UI.
 *
 * Why load everything up-front rather than searching server-side:
 *   The studio's client base is small enough (low four-figures at
 *   absolute most) that a single SELECT is cheaper than the
 *   debounced request-per-keystroke pattern, and it lets the search
 *   feel truly real-time (no flicker, no network spinner). Once the
 *   table grows past ~10k rows we'd switch to server-side ILIKE
 *   queries with pagination — this file is the right place to make
 *   that switch when the time comes.
 */
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import type { Client } from '../types';
import ClientDirectory from './ClientDirectory';

// Same dynamic posture as the other admin pages: this route reads
// Clerk cookies and queries Postgres on every render. Static
// optimisation would fail at build time when env vars aren't present.
export const dynamic = 'force-dynamic';

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

export default async function ClientsPage() {
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  let clients: Client[] = [];
  let dbError: string | null = null;
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
          )
      ) stats ON TRUE
      ORDER BY c.first_name ASC NULLS LAST, c.last_name ASC NULLS LAST
    `;
    clients = rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      created_at: serializeDate(r.created_at),
      total_bookings: toNumber(r.total_bookings),
      lifetime_value: toNumber(r.lifetime_value),
      has_vaulted_card: Boolean(r.has_vaulted_card),
      risk_flag: Boolean(r.risk_flag),
      last_booked_at: serializeDate(r.last_booked_at),
    }));
  } catch (err) {
    console.error('[admin/clients] clients query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="Clients" displayName={displayName} />
      <AdminSectionTabs />

      <main className="mx-auto max-w-4xl px-6 py-8">
        {dbError && (
          <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load clients: {dbError}. Try refreshing — if it
            keeps failing, check the Postgres connection.
          </div>
        )}

        <ClientDirectory clients={clients} />
      </main>
    </div>
  );
}
