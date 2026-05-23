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
//
// The time grid is RELATIVE-sized — it fills whatever vertical space its
// parent flex container offers, with all hour rows distributed evenly via
// `grid-template-rows: repeat(HOURS, 1fr)`. Appointment pills position
// themselves with percentages (`topPct`, `heightPct`) so they stretch &
// shrink with the container — no internal scrolling, the whole 9 AM →
// 9 PM window is always visible at once.
//
// We deliberately do NOT export GRID_HEIGHT_PX anymore: the grid has no
// fixed pixel height. HOUR_HEIGHT_PX is kept around purely as a CSS floor
// (via min-height) on the hour-label rows so labels stay legible on very
// short viewports.
export const START_HOUR = 9;  // 9 AM — first visible hour
export const END_HOUR = 21;   // 9 PM — last visible hour (exclusive end)
export const HOURS = END_HOUR - START_HOUR; // 12

/**
 * Minimum pill height in pixels. Micro-appointments (e.g. 15-min touch-ups)
 * would otherwise become unclickable slivers as the parent shrinks. We
 * apply this as a CSS `min-height` on each pill, layered on top of the
 * percent-based `heightPct`.
 */
export const MIN_PILL_HEIGHT_PX = 22;

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
export interface PositionedAppointment {
  appointment: Appointment;
  /** Top offset as a percentage (0-100) of the visible day window. */
  topPct: number;
  /** Height as a percentage (0-100) of the visible day window.
   *  Consumers should ALSO apply `min-height: MIN_PILL_HEIGHT_PX` via CSS
   *  so micro-appointments stay clickable when the parent is short. */
  heightPct: number;
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
 * Convert an appointment's start/end timestamps into a top/height pair,
 * expressed as percentages of the visible START_HOUR..END_HOUR window.
 * Returns null when the appointment is malformed or falls entirely
 * outside that window.
 *
 * Math:
 *   topPct    = ((minutesFromVisibleStart) / totalVisibleMinutes) * 100
 *   heightPct = (durationMinutes / totalVisibleMinutes) * 100
 *
 * We use millisecond arithmetic instead of doing hours/minutes math by
 * hand because it correctly handles DST transitions, sub-minute starts,
 * and end-of-day wraparounds with one expression.
 *
 * Why percentages instead of pixels: the grid is responsive — it fills
 * whatever vertical space its parent offers, so positions need to scale
 * with container height. Consumers add `min-height: MIN_PILL_HEIGHT_PX`
 * via CSS to keep micro-appointments clickable on short viewports.
 */
export function positionFor(
  apt: Appointment
): { topPct: number; heightPct: number } | null {
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

  const totalVisibleMinutes = HOURS * 60;
  const minutesFromVisibleStart = (startMs - visibleStartMs) / 60000;
  const durationMinutes = (endMs - startMs) / 60000;

  const topPct = (minutesFromVisibleStart / totalVisibleMinutes) * 100;
  const heightPct = (durationMinutes / totalVisibleMinutes) * 100;
  return { topPct, heightPct };
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
  raw: { apt: Appointment; topPct: number; heightPct: number }[]
): PositionedAppointment[] {
  const sorted = [...raw].sort((a, b) => a.topPct - b.topPct);
  const lanes: { end: number }[] = [];
  const colByIdx: number[] = [];

  sorted.forEach((it) => {
    const start = it.topPct;
    const end = it.topPct + it.heightPct;
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
    topPct: it.topPct,
    heightPct: it.heightPct,
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
  const positioned: { apt: Appointment; topPct: number; heightPct: number }[] =
    [];
  for (const apt of appointments) {
    const start = safeParseISO(apt.booking_time);
    if (!start || !isSameDay(start, date)) continue;
    const pos = positionFor(apt);
    if (!pos) continue;
    positioned.push({ apt, topPct: pos.topPct, heightPct: pos.heightPct });
  }
  return packLanes(positioned);
}
