/**
 * Cal.com /schedules helpers shared by the admin Availability page
 * and the /api/admin/availability proxy route.
 *
 * Cal.com v2 / v1 note:
 *   The original spec for this feature was written against Cal.com
 *   v1 — which was decommissioned in May 2026 (see the same note in
 *   app/api/admin/services/route.ts). We implement against the
 *   live v2 surface and map the v1 vocabulary in the spec onto v2
 *   shapes so this stays the single canonical reference for the
 *   feature.
 *
 * Notable v2 differences vs the spec:
 *   • cal-api-version: 2024-06-11 (Cal version-locks per resource —
 *     event-types pin to 2024-06-14, schedules to 2024-06-11).
 *   • availability days are STRING names ("Monday", …) not the
 *     integers the spec showed (0–6). The UI continues to speak
 *     integers internally; this module is the single point of
 *     translation between the two vocabularies.
 *   • overrides REQUIRE startTime + endTime in v2. The spec's
 *     "empty times array" idea isn't representable on the wire, so
 *     we encode "unavailable all day" as
 *     startTime === endTime === "00:00". Cal.com's own dashboard
 *     uses the same convention.
 *
 * The shared helper module pattern mirrors app/admin/services/sync.ts
 * so the proxy route and the Server Component can both query Cal
 * without one going through the other's HTTP hop.
 */
import { callCal } from '@/app/admin/services/sync';

/**
 * Cal.com pins each resource to its own API version. Schedules was
 * stabilised at 2024-06-11; event-types is on 2024-06-14. Both share
 * the same Bearer-auth flow, just different version headers.
 */
const SCHEDULES_API_VERSION = '2024-06-11';

/** Mountain Time — the studio is in Lehi, UT. Forced on every PATCH. */
export const STUDIO_TIMEZONE = 'America/Denver';

/** v2 wire format for the days[] array on each availability block. */
export type DayName =
  | 'Sunday'
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

/**
 * Day index used by `Date#getDay()` and (per the original spec) the
 * UI's internal representation. 0 = Sunday, 6 = Saturday.
 */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Ordered tuple of every valid {@link DayIndex} — used for iteration. */
export const DAY_INDICES: readonly DayIndex[] = [0, 1, 2, 3, 4, 5, 6];

const DAY_NAME_BY_INDEX: Record<DayIndex, DayName> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

const DAY_INDEX_BY_NAME: Record<DayName, DayIndex> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

export function dayNameFromIndex(index: DayIndex): DayName {
  return DAY_NAME_BY_INDEX[index];
}

export function dayIndexFromName(name: DayName): DayIndex {
  return DAY_INDEX_BY_NAME[name];
}

/** `HH:MM` 24-hour string, no seconds. Matches Cal's TIME_FORMAT_HH_MM. */
export type HHMM = string;

/**
 * Sentinel value used when encoding "unavailable all day" overrides.
 * Cal.com's v2 schema requires both startTime and endTime on every
 * override; the convention to mark "blocked" is a zero-minute window.
 */
export const UNAVAILABLE_TIME: HHMM = '00:00';

/** True if the override window encodes "unavailable all day". */
export function isUnavailableOverride(o: ScheduleOverride): boolean {
  return o.startTime === o.endTime;
}

/** A single recurring weekly block. Multiple days may share one block. */
export interface ScheduleAvailability {
  days: DayName[];
  startTime: HHMM;
  endTime: HHMM;
}

/** A single one-off date override (replaces the weekly block for that day). */
export interface ScheduleOverride {
  date: string; // YYYY-MM-DD
  startTime: HHMM;
  endTime: HHMM;
}

/** Full v2 schedule shape returned by GET /v2/schedules/{id}. */
export interface Schedule {
  id: number;
  ownerId: number;
  name: string;
  timeZone: string;
  isDefault: boolean;
  availability: ScheduleAvailability[];
  overrides: ScheduleOverride[];
}

/** Outer envelope Cal.com v2 wraps every response in. */
interface CalV2Envelope<T> {
  status?: 'success' | 'error';
  data?: T;
}

// ─── REMOTE HELPERS ────────────────────────────────────────────────────────

/**
 * Fetch the studio's default schedule.
 *
 * v2 doesn't expose a `/schedules/default` endpoint — we list every
 * schedule owned by the API key and pick the one flagged
 * `isDefault: true`. Falls back to the first schedule if none is
 * marked default (this shouldn't happen in practice but is cheap
 * to handle gracefully — Cal always creates a default on signup).
 *
 * Throws on no schedules returned at all: that's almost certainly
 * an auth error or a misconfigured key, and the caller should bubble
 * the message verbatim to the editor.
 */
export async function fetchDefaultSchedule(apiKey: string): Promise<Schedule> {
  const response = await callCal<CalV2Envelope<Schedule[]>>(
    '/schedules',
    apiKey,
    {
      method: 'GET',
      // Override the shared helper's default version header — schedules
      // lives on a different Cal API revision than event-types.
      headers: { 'cal-api-version': SCHEDULES_API_VERSION },
    }
  );
  const list = response.data;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      'Cal.com returned no schedules for this account — check that CAL_API_KEY belongs to a user with at least one schedule.'
    );
  }
  return list.find((s) => s.isDefault) ?? list[0];
}

/**
 * PATCH the given schedule with new recurring + override arrays.
 *
 * We always force `timeZone` to {@link STUDIO_TIMEZONE} so the math
 * Cal does behind the scenes (slot generation, DST conversion) is
 * anchored to Mountain Time even if the schedule was originally
 * created in a different zone. The recurring + override times we
 * send below are interpreted in this zone.
 *
 * Returns the updated schedule echoed back by Cal so the caller can
 * replace its local state with the canonical post-write shape.
 */
export interface UpdateSchedulePayload {
  availability: ScheduleAvailability[];
  overrides: ScheduleOverride[];
}

export async function updateSchedule(
  apiKey: string,
  scheduleId: number,
  payload: UpdateSchedulePayload
): Promise<Schedule> {
  const response = await callCal<CalV2Envelope<Schedule>>(
    `/schedules/${scheduleId}`,
    apiKey,
    {
      method: 'PATCH',
      headers: { 'cal-api-version': SCHEDULES_API_VERSION },
      body: JSON.stringify({
        timeZone: STUDIO_TIMEZONE,
        availability: payload.availability,
        overrides: payload.overrides,
      }),
    }
  );
  if (!response.data) {
    throw new Error(
      'Cal.com PATCH response missing `data` field — schedule likely updated, but the echo back was unusable.'
    );
  }
  return response.data;
}
