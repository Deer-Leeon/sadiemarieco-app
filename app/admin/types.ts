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
  service_name: string | null;
  status: string | null;
}

export type ViewMode = 'list' | 'calendar';
