/**
 * Shared geometry + math for all time-blocked dashboard surfaces.
 *
 * Both `TimeGrid` (3-day & week views) and `SingleDayModal` need pixel-
 * identical positioning so a click in TimeGrid opens the modal at the
 * same visual coordinates — never duplicate this math; import it.
 */
import { isSameDay, parseISO, startOfDay } from 'date-fns';

import type { Appointment } from './types';

// ──────────────────────────────────────────────────────────────────────────
// Geometry constants
// ──────────────────────────────────────────────────────────────────────────
export const HOUR_HEIGHT_PX = 80;
export const START_HOUR = 7; // 7 AM — first visible hour
export const END_HOUR = 19;  // 7 PM — last visible hour (exclusive end)
export const HOURS = END_HOUR - START_HOUR; // 12
export const GRID_HEIGHT_PX = HOURS * HOUR_HEIGHT_PX; // 960

/**
 * Anything ≤ this many minutes still renders at this minimum pixel
 * height so micro-appointments (e.g. 15-min touch-ups) stay readable
 * instead of becoming unclickable slivers.
 */
export const MIN_PILL_HEIGHT_PX = 22;

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
export interface PositionedAppointment {
  appointment: Appointment;
  /** Pixels from the top of the START_HOUR line. */
  top: number;
  /** Pixel height, already clamped to MIN_PILL_HEIGHT_PX. */
  height: number;
  /** 0-indexed lane within the overlap-packed layout for the day. */
  col: number;
  /** Total number of lanes the day needs — uniform across the day. */
  totalCols: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────
export function safeParseISO(iso: string | null): Date | null {
  if (!iso) return null;
  const d = parseISO(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ──────────────────────────────────────────────────────────────────────────
// Positioning
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convert an appointment's start/end timestamps into a top/height pair
 * clipped to the visible START_HOUR..END_HOUR window. Returns null when
 * the appointment is malformed or falls entirely outside that window.
 *
 * Math (per spec):
 *   top    = ((startHour + startMinute/60) - START_HOUR) * HOUR_HEIGHT_PX
 *   height = (durationMinutes / 60) * HOUR_HEIGHT_PX
 *
 * We use millisecond arithmetic instead of doing hours/minutes math by
 * hand because it correctly handles DST transitions, sub-minute starts,
 * and end-of-day wraparounds with one expression.
 */
export function positionFor(
  apt: Appointment
): { top: number; height: number } | null {
  const start = safeParseISO(apt.booking_time);
  if (!start) return null;

  // Default to a 60-minute block when end_time is missing — keeps legacy
  // rows (pre-end_time column) visually honest without fabricating data
  // back into Postgres.
  const end =
    safeParseISO(apt.end_time) ?? new Date(start.getTime() + 60 * 60 * 1000);

  const dayStart = startOfDay(start);
  const visibleStartMs = dayStart.getTime() + START_HOUR * 60 * 60 * 1000;
  const visibleEndMs = dayStart.getTime() + END_HOUR * 60 * 60 * 1000;

  const startMs = Math.max(start.getTime(), visibleStartMs);
  const endMs = Math.min(end.getTime(), visibleEndMs);

  if (endMs <= startMs) return null;

  const minutesFromVisibleStart = (startMs - visibleStartMs) / 60000;
  const durationMinutes = (endMs - startMs) / 60000;

  const top = (minutesFromVisibleStart / 60) * HOUR_HEIGHT_PX;
  const rawHeight = (durationMinutes / 60) * HOUR_HEIGHT_PX;
  return { top, height: Math.max(rawHeight, MIN_PILL_HEIGHT_PX) };
}

// ──────────────────────────────────────────────────────────────────────────
// Lane packing (overlap layout)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Greedy interval-graph colouring: place each appointment in the lowest-
 * indexed lane whose previous item has already ended, opening new lanes
 * as needed. The same `totalCols` value is assigned to every item so
 * column widths stay visually uniform across the day (slightly under-
 * utilising horizontal space for sparse clusters in exchange for a
 * predictable, calmer-looking grid).
 */
function packLanes(
  raw: { apt: Appointment; top: number; height: number }[]
): PositionedAppointment[] {
  const sorted = [...raw].sort((a, b) => a.top - b.top);
  const lanes: { end: number }[] = [];
  const colByIdx: number[] = [];

  sorted.forEach((it) => {
    const start = it.top;
    const end = it.top + it.height;
    let placed = false;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].end <= start) {
        lanes[i].end = end;
        colByIdx.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lanes.push({ end });
      colByIdx.push(lanes.length - 1);
    }
  });

  const totalCols = Math.max(lanes.length, 1);
  return sorted.map((it, i) => ({
    appointment: it.apt,
    top: it.top,
    height: it.height,
    col: colByIdx[i],
    totalCols,
  }));
}

/**
 * Filter appointments to a single local-calendar day and return them
 * with their positioning + overlap-lane assignments. Timezone-safe:
 * `isSameDay` works against the JS runtime's local time, which is the
 * studio's frame of reference (DB stores UTC; the user sees local).
 */
export function layoutForDay(
  date: Date,
  appointments: Appointment[]
): PositionedAppointment[] {
  const positioned: { apt: Appointment; top: number; height: number }[] = [];
  for (const apt of appointments) {
    const start = safeParseISO(apt.booking_time);
    if (!start || !isSameDay(start, date)) continue;
    const pos = positionFor(apt);
    if (!pos) continue;
    positioned.push({ apt, top: pos.top, height: pos.height });
  }
  return packLanes(positioned);
}
