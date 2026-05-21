import { auth, currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';
import { redirect } from 'next/navigation';

import DashboardUI from './DashboardUI';
import type { Appointment } from './types';

// Reads cookies (Clerk) and queries Postgres on every render. Force dynamic
// so Next doesn't try to statically optimise — without this `next build`
// may attempt to prerender and fail when Clerk/POSTGRES env vars aren't
// available at build time.
export const dynamic = 'force-dynamic';

// Hardcoded allowlist. See helpers/comments in the prior implementation
// (page.server.tsx) for rationale on iterating all linked emails rather
// than checking `[0]` only.
const ALLOWED_EMAILS = new Set([
  'lj.buchmiller@gmail.com',
  'mckenna@sadiemarie.co',
]);

interface DbRow {
  id: number;
  client_first_name: string | null;
  client_last_name: string | null;
  // @vercel/postgres returns TIMESTAMPTZ as a Date in some environments
  // and an ISO string in others. We normalise both before crossing the
  // server → client boundary.
  booking_time: Date | string | null;
  end_time: Date | string | null;
  service_name: string | null;
  status: string | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default async function AdminPage() {
  // ── AUTH GATE ────────────────────────────────────────────────────────────
  // Middleware enforces "signed in" before this server component runs. We
  // re-check here as defence-in-depth in case middleware is mis-configured.
  const { userId } = await auth();
  if (!userId) {
    redirect('/');
  }

  const user = await currentUser();
  const userEmails =
    user?.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];
  const hasAccess = userEmails.some((e) => ALLOWED_EMAILS.has(e));

  if (!hasAccess) {
    redirect('/');
  }

  // ── DATA FETCH ──────────────────────────────────────────────────────────
  // Window: last 30 days of history + all future bookings. This gives the
  // calendar view enough past data to plot a meaningful month while
  // keeping the list view focused on operationally-relevant appointments
  // (recent + upcoming, not 2-year-old archive).
  //
  // Excludes NULL booking_times: rows with missing times can't be placed
  // on a timeline so they shouldn't appear in a date-windowed query. (The
  // ListView's 'Unscheduled' bucket is defensive code from before this
  // filter — costs nothing to keep but will not be exercised in normal
  // operation.)
  //
  // ORDER BY ASC because the UI re-sorts on the client anyway (ListView
  // groups newest-first; CalendarView is grid-based). Ascending at the
  // DB layer is more debuggable for any raw inspection.
  //
  // LIMIT 1000 is a safety ceiling — 30d+future for a single studio won't
  // realistically exceed ~200 rows, but an unbounded query would be a
  // memory foot-gun if the data ever gets unexpectedly large.
  //
  // Wrapped so a DB outage shows a graceful banner in the UI instead of
  // surfacing the Next.js error boundary.
  let appointments: Appointment[] = [];
  let dbError: string | null = null;
  try {
    const { rows } = await sql<DbRow>`
      SELECT id, client_first_name, client_last_name, booking_time, end_time,
             service_name, status
      FROM appointments
      WHERE booking_time >= NOW() - INTERVAL '30 days'
      ORDER BY booking_time ASC
      LIMIT 1000
    `;
    appointments = rows.map<Appointment>((r) => ({
      id: r.id,
      client_first_name: r.client_first_name,
      client_last_name: r.client_last_name,
      booking_time: serializeDate(r.booking_time),
      end_time: serializeDate(r.end_time),
      service_name: r.service_name,
      status: r.status,
    }));
  } catch (err) {
    console.error('[admin] appointments query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  const displayName =
    user?.firstName || userEmails[0] || 'Admin';

  return (
    <DashboardUI
      appointments={appointments}
      dbError={dbError}
      displayName={displayName}
    />
  );
}
