import { auth, currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';
import { redirect } from 'next/navigation';

import { loadCalEventTypeMaps } from '@/lib/cal-config';

import DashboardUI from './DashboardUI';
import type { Appointment, TimeBlock } from './types';

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
  booking_notes: string | null;
  // NUMERIC arrives from Postgres as a string. We coerce in the row
  // mapping below so the client sees a clean `number | null`.
  service_price: string | null;
  service_description: string | null;
  // Editor-assigned hex from site_services.color (joined below). When
  // set, the calendar uses this over the auto-matcher heuristics; see
  // `app/admin/serviceColors.ts` for the resolution order.
  service_color: string | null;
  // Stripe Customer id (`cus_…`) for the vaulted card-on-file. Written
  // by /api/booking/confirm after a successful SetupIntent on /checkout.
  // Null for legacy / admin-created bookings — see types.ts.
  stripe_customer_id: string | null;
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
  let timeBlocks: TimeBlock[] = [];
  let dbError: string | null = null;
  let manualBookingServices: Awaited<
    ReturnType<typeof loadCalEventTypeMaps>
  >['services'] = [];
  let manualBookingGroupHeaders: Awaited<
    ReturnType<typeof loadCalEventTypeMaps>
  >['groupHeaders'] = [];

  try {
    const calMaps = await loadCalEventTypeMaps();
    manualBookingServices = calMaps.services;
    manualBookingGroupHeaders = calMaps.groupHeaders;
  } catch (err) {
    console.error('[admin] loadCalEventTypeMaps failed:', err);
  }

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
    // of the 2-Week / 3-Week / 4-Week Fill groups). A naive title-only
    // join picked the same `site_services.color` for every fill week
    // (always the most-recently-updated "Volume" row). For those bare
    // fill titles we also match on appointment duration (120 / 150 /
    // 180 min) so each week group keeps its editor-assigned hex.
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
        a.stripe_customer_id,
        a.booking_notes,
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
      booking_notes: r.booking_notes,
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
      service_color: r.service_color,
      stripe_customer_id: r.stripe_customer_id,
    }));
  } catch (err) {
    console.error('[admin] appointments query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  try {
    const { rows: blockRows } = await sql<{
      id: string;
      start_time: Date | string;
      end_time: Date | string;
      note: string | null;
      cal_booking_uid: string | null;
      cal_booking_uids: unknown;
    }>`
      SELECT id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
      FROM studio_time_blocks
      WHERE end_time >= NOW() - INTERVAL '30 days'
      ORDER BY start_time ASC
      LIMIT 500
    `;
    timeBlocks = blockRows.map((r) => {
      const uids = Array.isArray(r.cal_booking_uids)
        ? r.cal_booking_uids.filter(
            (uid): uid is string => typeof uid === 'string' && uid.length > 0
          )
        : [];
      return {
        id: r.id,
        start_time: serializeDate(r.start_time) ?? '',
        end_time: serializeDate(r.end_time) ?? '',
        note: r.note,
        cal_booking_uid: r.cal_booking_uid,
        cal_booking_uids:
          uids.length > 0 ? uids : r.cal_booking_uid ? [r.cal_booking_uid] : [],
      };
    });
  } catch (err) {
    console.error('[admin] studio_time_blocks query failed:', err);
    if (!dbError) {
      dbError =
        err instanceof Error ? err.message : 'Could not load time blocks';
    }
  }

  const displayName =
    user?.firstName || userEmails[0] || 'Admin';

  return (
    <DashboardUI
      appointments={appointments}
      timeBlocks={timeBlocks}
      dbError={dbError}
      displayName={displayName}
      manualBookingServices={manualBookingServices}
      manualBookingGroupHeaders={manualBookingGroupHeaders}
    />
  );
}
