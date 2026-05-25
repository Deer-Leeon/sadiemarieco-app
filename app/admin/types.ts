/**
 * Shared types for the admin dashboard. Lives in its own file so both the
 * server component (page.tsx) and the client components (DashboardUI,
 * ListView, CalendarView) can import without dragging in React.
 */

/**
 * Lifecycle status for an appointment row.
 *
 *   • 'pending'             — Cal.com webhook inserted the row but the
 *                             client hasn't completed the card-vaulting
 *                             handoff at /checkout yet. Hidden from the
 *                             Month/Week/3-Day calendar views so an
 *                             abandoned cart doesn't squat on a slot in
 *                             the admin's visual schedule; still visible
 *                             in List view with an "Awaiting Payment"
 *                             badge so the admin can audit drop-offs.
 *                             Transitions to 'confirmed' as soon as
 *                             /api/booking/confirm finishes its work.
 *   • 'confirmed'           — booking is live and on the schedule.
 *   • 'no-show'             — booking happened but the client never
 *                             arrived. Stays visible on the calendar
 *                             with a struck-through visual treatment
 *                             so the studio can still see what slot
 *                             was wasted.
 *   • 'canceled_by_admin'   — McKenna cancelled the slot from the
 *                             dashboard. Triggers an outbound Cal.com
 *                             cancellation (which fires Cal's native
 *                             client-facing email), then disappears
 *                             from calendar views entirely.
 *   • 'canceled_by_client'  — client cancelled via the manage portal
 *                             or directly through Cal's confirmation
 *                             email. The webhook flips the row here.
 *                             Also disappears from calendar views.
 *   • 'canceled_by_system'  — abandoned-checkout sweep released the
 *                             hold automatically. Written by the
 *                             `/api/cron/cleanup-abandoned` route when
 *                             a 'pending' row has been sitting for
 *                             longer than the abandonment window
 *                             (10 minutes) without a card on file.
 *                             Cal.com is rejected upstream so the slot
 *                             is bookable again, and the row stays in
 *                             the DB for audit / drop-off analytics.
 *
 * Mirrors the CHECK constraint added in
 * `scripts/update_status_constraint.sql` and amended by
 * `scripts/add_pending_status.sql` + `scripts/add_canceled_by_system_status.sql`.
 * If you add a new status, update BOTH this union AND the SQL CHECK
 * so the DB and the type system stay aligned.
 */
export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'no-show'
  | 'canceled_by_admin'
  | 'canceled_by_client'
  | 'canceled_by_system';

/**
 * Tuple form of `AppointmentStatus` for runtime validation in API
 * routes. Kept as `readonly` so callers can't accidentally mutate the
 * canonical list, and `as const` so it widens correctly into the
 * `AppointmentStatus` union when iterated.
 */
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'pending',
  'confirmed',
  'no-show',
  'canceled_by_admin',
  'canceled_by_client',
  'canceled_by_system',
] as const;

/**
 * Predicate for narrowing an arbitrary string to `AppointmentStatus`.
 * Used by both the PATCH route (request body validation) and any UI
 * code that wants to safely read `appointment.status` (which is
 * `string | null` on the wire because the DB column is `text` —
 * any legacy/unknown value should fall through to a neutral display).
 */
export function isAppointmentStatus(
  value: unknown
): value is AppointmentStatus {
  return (
    typeof value === 'string' &&
    (APPOINTMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Serialised appointment shape — what the server passes to the client.
 *
 * `booking_time` is intentionally a string (ISO 8601), not a Date. Dates
 * don't survive React's server-to-client serialisation cleanly in all
 * runtimes, and being explicit about the wire format makes the boundary
 * easier to reason about. The client parses with `date-fns/parseISO`.
 */
export interface Appointment {
  /** Local Postgres primary key (UUID in the live schema). */
  id: string;
  /**
   * Cal.com booking UID — the unique identifier Cal stamps on every
   * booking when it fires the webhook (e.g. `buiaE8jHmNAxLrqitahCeL`).
   * Stored on the DB side as `appointments.cal_event_id` (the column
   * name predates this field's purpose — it actually holds the BOOKING
   * uid, not the event-type id). We surface it under `cal_uid` here so
   * the property reads cleanly at call sites and never collides with
   * our local Postgres `id`.
   *
   * Required by Cal's reschedule URL: `cal.com/reschedule/<cal_uid>`
   * resolves to a "pick a new time" flow that emails the client on
   * confirmation. Nullable defensively; in practice every appointment
   * row has one (the webhook writes it on insert and the column is
   * `NOT NULL` in the live schema).
   */
  cal_uid: string | null;
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
  /**
   * One of `AppointmentStatus`, or `null` for malformed legacy rows
   * that predate the CHECK constraint. Kept as `string | null` on the
   * wire (rather than narrowing here) because the column type is
   * `text` and we want unknown values to surface as "Unknown" in
   * the UI rather than break the row. Use `isAppointmentStatus` to
   * narrow before branching on a specific status.
   */
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
  /**
   * Cal.com event-type slug, joined in from `site_services.slug`.
   * Needed by the reschedule embed to build a calLink in the form
   * `<username>/<slug>` — Cal's iframe embed can't render the
   * top-level `/reschedule/<uid>` redirect (returns "Cal Link
   * seems to be wrong"), so we instead load the actual event-type
   * page and pass `rescheduleUid` as a config-level query param.
   * Null when the appointment's service title no longer matches a
   * current CMS row (renamed/deleted services) — the Reschedule
   * button is disabled in that case.
   */
  service_slug: string | null;
  /**
   * Editor-assigned hex colour for this service, joined in from
   * `site_services.color`. When non-null this wins over the keyword
   * + duration auto-matcher in `serviceColors.ts`. Null means
   * "no override — fall back to the auto-matcher", which preserves
   * the pre-CMS-colour behaviour for legacy bookings and any service
   * the editor never customised. Always in the canonical `#RRGGBB`
   * form (enforced by the CHECK constraint on the column).
   */
  service_color: string | null;
  /**
   * Stripe Customer id (`cus_…`) for the vaulted card-on-file. Written
   * by `/api/booking/confirm` after a successful SetupIntent on the
   * `/checkout` page. Null when:
   *   • Legacy booking created before card vaulting shipped, OR
   *   • Booking flow that didn't route through /checkout (e.g. an
   *     admin-created appointment).
   *
   * The PaymentMethod attached to this Customer is `off_session`-
   * usable, so late-cancel / no-show fees can be charged without
   * re-collecting the card. Mirrors the column added in
   * `scripts/add_appointments_stripe_customer_id.sql` — keep the
   * union here and the CHECK constraint there aligned.
   */
  stripe_customer_id: string | null;
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

