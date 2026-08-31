/**
 * Resolve "planned studio hours" from a Cal.com schedule (weekly blocks +
 * date overrides). Used by the manual-booking calendar to border studio
 * days and color in-hours vs out-of-hours slots.
 *
 * Override rules (Cal v2):
 *   • An override for a date fully replaces the weekly block that day.
 *   • startTime === endTime means unavailable all day (no studio border).
 *   • A custom override window makes that date a studio day even if the
 *     weekday is normally off.
 */

export type DayName =
  | 'Sunday'
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

export interface StudioAvailabilityBlock {
  days: DayName[];
  startTime: string; // HH:MM
  endTime: string;
}

export interface StudioDateOverride {
  date: string; // YYYY-MM-DD
  startTime: string;
  endTime: string;
}

export interface StudioTimeWindow {
  startTime: string;
  endTime: string;
}

const DAY_NAMES: readonly DayName[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Cal's "blocked all day" convention. */
export function isUnavailableOverride(o: StudioDateOverride): boolean {
  return o.startTime === o.endTime;
}

function dayNameFromYmd(ymd: string): DayName | null {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  // Noon UTC avoids DST edge cases when deriving weekday from a calendar date.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return DAY_NAMES[dow] ?? null;
}

function hhmmToMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Inclusive start, exclusive-or-equal end, in minutes from midnight. */
export interface MinuteBand {
  startMins: number;
  endMins: number;
}

/** Visible admin time-grid window (9 AM – 9 PM). */
export const VISIBLE_GRID_START_MINS = 9 * 60;
export const VISIBLE_GRID_END_MINS = 21 * 60;

function clipBand(
  band: MinuteBand,
  gridStart: number,
  gridEnd: number
): MinuteBand | null {
  const start = Math.max(band.startMins, gridStart);
  const end = Math.min(band.endMins, gridEnd);
  if (!(end > start)) return null;
  return { startMins: start, endMins: end };
}

function mergeBands(bands: MinuteBand[]): MinuteBand[] {
  const sorted = bands
    .filter((b) => b.endMins > b.startMins)
    .map((b) => ({ startMins: b.startMins, endMins: b.endMins }))
    .sort((a, b) => a.startMins - b.startMins || a.endMins - b.endMins);
  const out: MinuteBand[] = [];
  for (const band of sorted) {
    const last = out[out.length - 1];
    if (!last || band.startMins > last.endMins) {
      out.push(band);
    } else {
      last.endMins = Math.max(last.endMins, band.endMins);
    }
  }
  return out;
}

function invertOpenWindows(
  open: MinuteBand[],
  gridStart: number,
  gridEnd: number
): MinuteBand[] {
  const merged = mergeBands(
    open
      .map((b) => clipBand(b, gridStart, gridEnd))
      .filter((b): b is MinuteBand => b != null)
  );
  const closed: MinuteBand[] = [];
  let cursor = gridStart;
  for (const window of merged) {
    if (window.startMins > cursor) {
      closed.push({ startMins: cursor, endMins: window.startMins });
    }
    cursor = Math.max(cursor, window.endMins);
  }
  if (cursor < gridEnd) {
    closed.push({ startMins: cursor, endMins: gridEnd });
  }
  return closed;
}

function subtractHoles(closed: MinuteBand[], holes: MinuteBand[]): MinuteBand[] {
  if (holes.length === 0) return closed;
  const mergedHoles = mergeBands(holes);
  const out: MinuteBand[] = [];
  for (const band of closed) {
    let cursor = band.startMins;
    for (const hole of mergedHoles) {
      if (hole.endMins <= cursor) continue;
      if (hole.startMins >= band.endMins) break;
      const cutStart = Math.max(hole.startMins, cursor);
      const cutEnd = Math.min(hole.endMins, band.endMins);
      if (cutStart > cursor) {
        out.push({ startMins: cursor, endMins: cutStart });
      }
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < band.endMins) {
      out.push({ startMins: cursor, endMins: band.endMins });
    }
  }
  return out;
}

/**
 * Closed (unavailable) bands inside the visible 9 AM–9 PM grid for a
 * studio calendar day. Official weekly hours + date overrides are the
 * light regions; `holes` (booked appointment intervals) punch cream
 * gaps so out-of-hours admin bookings sit on the open background.
 *
 * Empty studio windows → the whole visible grid is closed, minus holes.
 */
export function closedBandsForVisibleGrid(
  ymd: string,
  availability: StudioAvailabilityBlock[],
  overrides: StudioDateOverride[],
  holes: MinuteBand[] = [],
  visibleStartMins: number = VISIBLE_GRID_START_MINS,
  visibleEndMins: number = VISIBLE_GRID_END_MINS
): MinuteBand[] {
  const windows = studioWindowsForDate(ymd, availability, overrides);
  const open: MinuteBand[] = [];
  for (const window of windows) {
    const start = hhmmToMinutes(window.startTime);
    const end = hhmmToMinutes(window.endTime);
    if (start == null || end == null || end <= start) continue;
    const clipped = clipBand(
      { startMins: start, endMins: end },
      visibleStartMins,
      visibleEndMins
    );
    if (clipped) open.push(clipped);
  }
  const closed = invertOpenWindows(open, visibleStartMins, visibleEndMins);
  const clippedHoles = holes
    .map((h) => clipBand(h, visibleStartMins, visibleEndMins))
    .filter((b): b is MinuteBand => b != null);
  return subtractHoles(closed, clippedHoles);
}

export function minuteBandsToPercents(
  bands: MinuteBand[],
  visibleStartMins: number = VISIBLE_GRID_START_MINS,
  visibleEndMins: number = VISIBLE_GRID_END_MINS
): { topPct: number; heightPct: number }[] {
  const total = visibleEndMins - visibleStartMins;
  if (total <= 0) return [];
  return bands.flatMap((band) => {
    const clipped = clipBand(band, visibleStartMins, visibleEndMins);
    if (!clipped) return [];
    return [
      {
        topPct: ((clipped.startMins - visibleStartMins) / total) * 100,
        heightPct: ((clipped.endMins - clipped.startMins) / total) * 100,
      },
    ];
  });
}

/** Best-effort parse of `GET /api/admin/availability`. */
export function parseAvailabilityPayload(data: unknown): {
  availability: StudioAvailabilityBlock[];
  overrides: StudioDateOverride[];
} | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.availability) || !Array.isArray(root.overrides)) {
    return null;
  }
  return {
    availability: root.availability as StudioAvailabilityBlock[],
    overrides: root.overrides as StudioDateOverride[],
  };
}

/**
 * Planned studio windows for a single YYYY-MM-DD (Mountain calendar date).
 * Empty array = not a studio day (no black border).
 */
export function studioWindowsForDate(
  ymd: string,
  availability: StudioAvailabilityBlock[],
  overrides: StudioDateOverride[]
): StudioTimeWindow[] {
  const forDate = overrides.filter((o) => o.date === ymd);
  if (forDate.length > 0) {
    // Any unavailable override for the date closes the whole day.
    if (forDate.some(isUnavailableOverride)) return [];
    return forDate
      .filter((o) => !isUnavailableOverride(o) && o.startTime < o.endTime)
      .map((o) => ({ startTime: o.startTime, endTime: o.endTime }));
  }

  const dayName = dayNameFromYmd(ymd);
  if (!dayName) return [];

  const windows: StudioTimeWindow[] = [];
  for (const block of availability) {
    if (!block.days.includes(dayName)) continue;
    if (block.startTime >= block.endTime) continue;
    windows.push({ startTime: block.startTime, endTime: block.endTime });
  }
  return windows;
}

export function isStudioDay(
  ymd: string,
  availability: StudioAvailabilityBlock[],
  overrides: StudioDateOverride[]
): boolean {
  return studioWindowsForDate(ymd, availability, overrides).length > 0;
}

/** Build the set of studio days (YYYY-MM-DD) in an inclusive date range. */
export function studioDaysInRange(
  rangeStart: string,
  rangeEnd: string,
  availability: StudioAvailabilityBlock[],
  overrides: StudioDateOverride[]
): Set<string> {
  const out = new Set<string>();
  if (rangeEnd < rangeStart) return out;

  const [sy, sm, sd] = rangeStart.split('-').map(Number);
  const [ey, em, ed] = rangeEnd.split('-').map(Number);
  const cursor = new Date(Date.UTC(sy, sm - 1, sd, 12));
  const end = new Date(Date.UTC(ey, em - 1, ed, 12));

  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    const ymd = `${y}-${m}-${d}`;
    if (isStudioDay(ymd, availability, overrides)) out.add(ymd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * True when the full appointment fits inside a planned studio window:
 * start is in [windowStart, windowEnd) and end (start + duration) is
 * ≤ windowEnd. A 3:00 start for a 90-minute service on a 10:00–16:00 day
 * is out-of-hours (ends 4:30) even though 3:00 itself is during studio time.
 *
 * When duration is missing/invalid, falls back to start-only membership.
 */
export function isAppointmentWithinStudioWindows(
  slotLocalHhmm: string,
  durationMins: number | null | undefined,
  windows: StudioTimeWindow[]
): boolean {
  const slotMins = hhmmToMinutes(slotLocalHhmm);
  if (slotMins == null) return false;

  const duration =
    typeof durationMins === 'number' &&
    Number.isFinite(durationMins) &&
    durationMins > 0
      ? durationMins
      : null;
  const endMins = duration == null ? null : slotMins + duration;

  for (const w of windows) {
    const start = hhmmToMinutes(w.startTime);
    const end = hhmmToMinutes(w.endTime);
    if (start == null || end == null) continue;
    if (slotMins < start || slotMins >= end) continue;
    if (endMins != null && endMins > end) continue;
    return true;
  }
  return false;
}

/**
 * @deprecated Prefer {@link isAppointmentWithinStudioWindows} so long
 * services that overrun studio end are marked out-of-hours.
 */
export function isSlotStartInStudioWindows(
  slotLocalHhmm: string,
  windows: StudioTimeWindow[]
): boolean {
  return isAppointmentWithinStudioWindows(slotLocalHhmm, null, windows);
}
