/**
 * Shared types for the admin dashboard. Lives in its own file so both the
 * server component (page.tsx) and the client components (DashboardUI,
 * ListView, CalendarView) can import without dragging in React.
 */

/**
 * Serialised appointment shape — what the server passes to the client.
 *
 * `booking_time` is intentionally a string (ISO 8601), not a Date. Dates
 * don't survive React's server-to-client serialisation cleanly in all
 * runtimes, and being explicit about the wire format makes the boundary
 * easier to reason about. The client parses with `date-fns/parseISO`.
 */
export interface Appointment {
  id: number;
  client_first_name: string | null;
  client_last_name: string | null;
  /** ISO 8601 string, or null if the booking has no scheduled time. */
  booking_time: string | null;
  /**
   * ISO 8601 string for the appointment's scheduled end (TIMESTAMPTZ
   * `end_time` in Postgres). Null if Cal.com didn't send an `endTime`
   * on the webhook payload — defensive, because in practice every
   * Cal event has a duration and therefore an end. Same wire format
   * as `booking_time` so the client can parse with `date-fns/parseISO`.
   */
  end_time: string | null;
  service_name: string | null;
  status: string | null;
  /**
   * Client's phone number as Cal.com sent it on the webhook (E.164
   * when the booking form's phone field was filled in correctly,
   * arbitrary string otherwise). Surfaced in the AppointmentModal
   * so the studio can call/text from the dashboard without bouncing
   * to Cal. Null when the client booked without supplying a phone.
   */
  client_phone: string | null;
  /**
   * Client's email. Same provenance as client_phone — captured at
   * booking time and denormalised onto the appointments row.
   */
  client_email: string | null;
  /**
   * Price for this appointment's service, joined in from
   * `site_services.price` on title match. Null when no matching CMS
   * row exists (legacy bookings, manually renamed services, etc.).
   * The modal hides the price line entirely when null rather than
   * showing a misleading "$0".
   */
  service_price: number | null;
  /**
   * Marketing description for the service, joined in from
   * `site_services.description`. Same nullability semantics as
   * service_price — the modal hides the description block when null
   * so it doesn't render an empty italic line.
   */
  service_description: string | null;
}

/**
 * Dashboard view modes.
 *
 *  - 'list'  : Day-grouped chronological list (ListView)
 *  - 'month' : 7-col month-grid (CalendarView) — was previously 'calendar'
 *  - '3day'  : Time-blocked agenda for the current day + next 2 (TimeGrid)
 *  - 'week'  : Time-blocked agenda for the Sun–Sat week containing
 *              the current date (TimeGrid)
 */
export type ViewMode = 'list' | 'month' | '3day' | 'week';

/**
 * Persisted CRM client. Mirrors the shape the API returns from
 * /api/admin/clients (POST upsert + GET lookup + PATCH update).
 *
 * Identifier discipline:
 *   - `id` is a UUID string (NOT a serial integer — the live `clients`
 *     table predates this feature and uses `uuid`/`gen_random_uuid()`).
 *   - `phone` is digits-only (normalised by the API before insert via
 *     `replace(/\D/g, '')`). Nullable for legacy rows that the
 *     pre-CRM webhook created keyed by email alone.
 *
 * The wire format uses ISO 8601 strings for timestamps — same
 * server→client convention as `Appointment` above. The client parses
 * with `date-fns/parseISO` where needed.
 */
export interface Client {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  /** ISO 8601 string. */
  created_at: string | null;
}

/**
 * Single row from the `client_photos` table — the photo gallery the
 * admin uploads to from ClientProfileModal. `blob_url` is the public
 * URL returned by @vercel/blob; the UI uses it directly as an
 * `<img src>`.
 */
export interface ClientPhoto {
  id: number;
  blob_url: string;
  /** ISO 8601 string. */
  uploaded_at: string;
}

/**
 * A row in the client's appointment history (what
 * /api/admin/clients/[id]/appointments returns). Lighter shape than
 * the dashboard's `Appointment` — we only show date, time, service
 * name and status in the modal's history list.
 */
export interface ClientAppointment {
  id: string;
  service_name: string | null;
  /** ISO 8601 string. */
  booking_time: string | null;
  /** ISO 8601 string. */
  end_time: string | null;
  status: string | null;
}
