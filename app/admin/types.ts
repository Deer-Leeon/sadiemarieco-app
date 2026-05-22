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
