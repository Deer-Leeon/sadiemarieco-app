/**
 * GET /api/admin/dashboard
 *
 * Read-only summary endpoint for the iOS admin app. The web dashboard
 * builds the same metrics inline in `/admin/page.tsx`; this route
 * exists so a native client can render the same surface without
 * reaching into Postgres directly.
 *
 * Response shape (success):
 *   {
 *     metrics: {
 *       activeBookings:   number,  // future, non-cancelled appointments
 *       upcomingRevenue:  number,  // whole dollars (rounded)
 *     },
 *     recentCustomers: Array<{
 *       id: string,
 *       firstName: string | null,
 *       lastName:  string | null,
 *       email:     string | null,
 *       joinedAt:  string,         // ISO 8601
 *     }>
 *   }
 *
 * Auth model:
 *   - Bearer token (Clerk session JWT) in `Authorization`. Clerk's
 *     `auth()` helper automatically resolves it on the App Router.
 *   - Admin gate: `sessionClaims.publicMetadata.role === 'admin'`.
 *     The iOS app sets this via Clerk publicMetadata on the user.
 *   - 401 if unauthenticated, 403 if signed in but not an admin.
 *
 * Schema note — `site_services.price`:
 *   The spec called this "int4 stored in cents", but the live schema
 *   (see scripts/migrate_services.sql) is `NUMERIC(10, 2)` storing
 *   DOLLARS. This handler honours the schema and does NOT divide by
 *   100 — the value coming out of the SUM is already in dollars and
 *   we just round to whole units for the dashboard tile.
 *
 * Schema note — `appointments.service_name`:
 *   Cal.com sends the booking title as `"<service title> between
 *   <client name>"`. We `split_part(..., ' between ', 1)` to recover
 *   the original `site_services.title` on the join, mirroring every
 *   other place in the codebase that needs to price an appointment.
 */
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

/**
 * Pinned to Node so `@vercel/postgres` (which depends on
 * `node:net`) can connect. Edge runtime would fail at request time.
 */
export const runtime = 'nodejs';

/**
 * Dashboard data must reflect the latest writes — never cache.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Statuses that count as "this booking is either dead or unconfirmed
 * and shouldn't appear in active counts / upcoming revenue".
 *
 * Mirrors `app/admin/types.ts` AppointmentStatus union and the SQL
 * CHECK in `scripts/update_status_constraint.sql` + amendments. If
 * you add a new cancelled-style status, list it here too.
 */
const INACTIVE_STATUSES = [
  'pending',
  'cancelled',
  'canceled_by_admin',
  'canceled_by_client',
  'canceled_by_client_late',
  'canceled_by_system',
] as const;

interface ActiveBookingsRow {
  active_bookings: number | string | null;
}

interface UpcomingRevenueRow {
  upcoming_revenue: number | string | null;
}

interface RecentCustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: Date | string;
}

interface DashboardResponse {
  metrics: {
    activeBookings: number;
    upcomingRevenue: number;
  };
  recentCustomers: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    joinedAt: string;
  }>;
}

/**
 * Coerce a Postgres numeric/text/null result into a finite JS number.
 * `@vercel/postgres` returns BIGINT and NUMERIC as strings to avoid
 * precision loss, so we accept either.
 */
function toFiniteNumber(value: number | string | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Best-effort role lookup off the Clerk session claims. We tolerate
 * either `publicMetadata.role` (the project's convention) or a
 * top-level `role` claim, since some Clerk JWT templates flatten
 * `public_metadata` into the root.
 */
function isAdminClaims(claims: Record<string, unknown> | null): boolean {
  if (!claims) return false;
  const direct = claims.role;
  if (typeof direct === 'string' && direct === 'admin') return true;
  const meta = claims.publicMetadata ?? claims.public_metadata;
  if (
    meta &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).role === 'admin'
  ) {
    return true;
  }
  return false;
}

export async function GET(): Promise<NextResponse> {
  // ── Auth ─────────────────────────────────────────────────────────
  const { userId, sessionClaims } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: 'Authentication required.' },
      { status: 401 }
    );
  }
  if (
    !isAdminClaims(
      (sessionClaims as Record<string, unknown> | null | undefined) ?? null
    )
  ) {
    return NextResponse.json(
      { error: 'Admin role required.' },
      { status: 403 }
    );
  }

  // ── Data ────────────────────────────────────────────────────────
  // Three independent queries — fire them concurrently so the round
  // trip cost is `max(t1, t2, t3)` instead of the serial sum. We
  // catch and rethrow so the surrounding try/catch sees the first
  // failure with a useful message.
  try {
    const [activeBookingsResult, upcomingRevenueResult, recentCustomersResult] =
      await Promise.all([
        sql<ActiveBookingsRow>`
          SELECT COUNT(*)::int AS active_bookings
          FROM appointments
          WHERE booking_time > NOW()
            AND COALESCE(LOWER(TRIM(status)), '') NOT IN (
              ${INACTIVE_STATUSES[0]},
              ${INACTIVE_STATUSES[1]},
              ${INACTIVE_STATUSES[2]},
              ${INACTIVE_STATUSES[3]},
              ${INACTIVE_STATUSES[4]},
              ${INACTIVE_STATUSES[5]}
            )
        `,
        sql<UpcomingRevenueRow>`
          SELECT COALESCE(SUM(s.price::numeric), 0)::float
            AS upcoming_revenue
          FROM appointments a
          LEFT JOIN LATERAL (
            SELECT s.price
            FROM site_services s
            WHERE s.title = split_part(a.service_name, ' between ', 1)
              AND s.is_active = TRUE
              AND (
                LOWER(TRIM(split_part(a.service_name, ' between ', 1))) NOT IN (
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
          WHERE a.booking_time > NOW()
            AND COALESCE(LOWER(TRIM(a.status)), '') NOT IN (
              ${INACTIVE_STATUSES[0]},
              ${INACTIVE_STATUSES[1]},
              ${INACTIVE_STATUSES[2]},
              ${INACTIVE_STATUSES[3]},
              ${INACTIVE_STATUSES[4]},
              ${INACTIVE_STATUSES[5]}
            )
        `,
        sql<RecentCustomerRow>`
          SELECT id, first_name, last_name, email, created_at
          FROM clients
          ORDER BY created_at DESC NULLS LAST
          LIMIT 5
        `,
      ]);

    const activeBookings = toFiniteNumber(
      activeBookingsResult.rows[0]?.active_bookings ?? 0
    );

    const upcomingRevenue = Math.round(
      toFiniteNumber(upcomingRevenueResult.rows[0]?.upcoming_revenue ?? 0)
    );

    const recentCustomers = recentCustomersResult.rows.map((row) => {
      const joinedAt =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
      return {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        joinedAt,
      };
    });

    const body: DashboardResponse = {
      metrics: { activeBookings, upcomingRevenue },
      recentCustomers,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    console.error('[api/admin/dashboard] query failed:', err);
    const message =
      err instanceof Error ? err.message : 'Unknown database error.';
    return NextResponse.json(
      { error: 'Failed to load dashboard data.', detail: message },
      { status: 500 }
    );
  }
}
