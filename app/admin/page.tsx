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
  id: string;
  // appointments.cal_event_id — actually stores the Cal.com booking
  // UID (despite the column name). Mapped to Appointment.cal_uid
  // below so the modal can build Cal's reschedule URL.
  cal_event_id: string | null;
  // site_services.slug — Cal.com event-type slug joined in below.
  // The reschedule embed needs this to construct the calLink path
  // (`<username>/<slug>`); the booking UID alone isn't enough,
  // because Cal's iframe loads the event-type page in reschedule
  // mode rather than the top-level /reschedule/<uid> redirect
  // (which Cal returns "Cal Link seems to be wrong" for inside
  // an embed). Null when the appointment's title doesn't resolve
  // to a current site_services row (legacy / renamed services).
  service_slug: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  // @vercel/postgres returns TIMESTAMPTZ as a Date in some environments
  // and an ISO string in others. We normalise both before crossing the
  // server → client boundary.
  booking_time: Date | string | null;
  end_time: Date | string | null;
  service_name: string | null;
  status: string | null;
  client_phone: string | null;
  client_email: string | null;
  // NUMERIC arrives from Postgres as a string. We coerce in the row
  // mapping below so the client sees a clean `number | null`.
  service_price: string | null;
  service_description: string | null;
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
    // LEFT JOIN to site_services on the cleaned service title so the
    // appointment-details modal can show the price + description
    // alongside the booking. Cal stores `service_name` as the FULL
    // event title ("Classic Lash Set between Sadie Marie and Leon"),
    // so we strip everything from the first ' between ' onward via
    // split_part before matching against site_services.title.
    //
    // The JOIN is LEFT (not INNER) so:
    //   • bookings for services renamed in the CMS after the booking
    //     was created still appear, just without price/description,
    //   • the dashboard never silently drops legacy rows whose
    //     service_name doesn't resolve to a current site_services row.
    //
    // Inactive site_services rows (is_active = FALSE) are filtered out
    // explicitly so a soft-deleted service doesn't keep enriching new
    // appointments after it's been retired.
    // LEFT JOIN LATERAL with LIMIT 1 instead of a plain LEFT JOIN: the
    // site_services table can hold multiple rows with the same title
    // (e.g. "Classic" / "Hybrid" / "Volume" exist as children under each
    // of the 2-Week / 3-Week / 4-Week Fill groups). A naive equality
    // join multiplies every appointment by the match count — same
    // booking rendered three times in every calendar view, same `id`
    // appearing as duplicate React keys (see browser console). The
    // lateral keeps exactly one enrichment row per appointment,
    // deterministically picking the most-recently-touched matching
    // service so the price / slug we display is the freshest available.
    const { rows } = await sql<DbRow>`
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
        s.slug        AS service_slug
      FROM appointments a
      LEFT JOIN LATERAL (
        SELECT s.price, s.description, s.slug
        FROM site_services s
        WHERE s.title = split_part(a.service_name, ' between ', 1)
          AND s.is_active = TRUE
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE a.booking_time >= NOW() - INTERVAL '30 days'
      ORDER BY a.booking_time ASC
      LIMIT 1000
    `;
    appointments = rows.map<Appointment>((r) => ({
      id: r.id,
      cal_uid: r.cal_event_id,
      client_first_name: r.client_first_name,
      client_last_name: r.client_last_name,
      booking_time: serializeDate(r.booking_time),
      end_time: serializeDate(r.end_time),
      service_name: r.service_name,
      status: r.status,
      client_phone: r.client_phone,
      client_email: r.client_email,
      // NUMERIC arrives stringified — coerce here so the client side
      // never has to think about parsing. Use Number() rather than
      // parseFloat so a non-numeric string surfaces as NaN, which we
      // then normalise to null so the modal hides the line cleanly.
      service_price:
        r.service_price === null
          ? null
          : (() => {
              const n = Number(r.service_price);
              return Number.isFinite(n) ? n : null;
            })(),
      service_description: r.service_description,
      service_slug: r.service_slug,
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
