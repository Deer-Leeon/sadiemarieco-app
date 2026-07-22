/**
 * Shared geometry + math for all time-blocked dashboard surfaces.
 *
 * Both `TimeGrid` (3-day & week views) and `SingleDayModal` need pixel-
 * identical positioning so a click in TimeGrid opens the modal at the
 * same visual coordinates — never duplicate this math; import it.
 */
import { isSameDay, parseISO, startOfDay } from 'date-fns';

import type { Appointment } from './types';

// Re-export for convenience in timeline consumers.
export type { TimeBlock } from './types';
import type { TimeBlock } from './types';

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

/** Minimum height per hour row in the single-day modal (readable pills). */
export const MODAL_HOUR_ROW_MIN_PX = 56;

export const MODAL_HOUR_GRID_ROWS = `repeat(${HOURS}, minmax(${MODAL_HOUR_ROW_MIN_PX}px, 1fr))`;

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
  /** 0-indexed lane within this appointment's overlap cluster. */
  col: number;
  /** Lane count for this overlap cluster only — 1 means full-width. */
  totalCols: number;
}

export interface PositionedTimeBlock {
  block: TimeBlock;
  topPct: number;
  heightPct: number;
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

  return positionInterval(start, end);
}

/**
 * Same visible-window math as `positionFor`, but for arbitrary intervals
 * (admin time blocks). Returns null when the interval falls entirely
 * outside START_HOUR..END_HOUR.
 */
export function positionInterval(
  start: Date,
  end: Date
): { topPct: number; heightPct: number } | null {
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

interface RawPositioned {
  apt: Appointment;
  topPct: number;
  heightPct: number;
  /** Epoch ms — overlap math uses real timestamps, not % floats. */
  startMs: number;
  endMs: number;
}

/**
 * Pack appointments into horizontal lanes, scoped per overlap cluster.
 *
 * Two appointments share a "cluster" only when their times transitively
 * overlap. Within a cluster we greedy-colour into the fewest lanes and
 * set `totalCols` to that cluster's concurrency. Appointments that don't
 * overlap anyone get `totalCols = 1` (full day-column width).
 *
 * Previously every item inherited the day's global max concurrency, so a
 * single overlapping pair made the whole day render as half-width rails
 * even for back-to-back bookings that fit in one column.
 */
function packLanes(raw: RawPositioned[]): PositionedAppointment[] {
  if (raw.length === 0) return [];

  const sorted = [...raw].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return b.endMs - a.endMs;
  });

  // Union-find so transitive overlaps share one cluster
  // (A overlaps B, B overlaps C ⇒ A/B/C pack together).
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // Sorted by start — once j starts at/after i ends, later j's can't
      // overlap i either.
      if (sorted[j].startMs >= sorted[i].endMs) break;
      if (sorted[i].startMs < sorted[j].endMs) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(i);
    else clusters.set(root, [i]);
  }

  const out: PositionedAppointment[] = new Array(sorted.length);

  for (const memberIdxs of clusters.values()) {
    const members = memberIdxs
      .map((i) => ({ i, item: sorted[i] }))
      .sort((a, b) => {
        if (a.item.startMs !== b.item.startMs) {
          return a.item.startMs - b.item.startMs;
        }
        return b.item.endMs - a.item.endMs;
      });

    const lanes: { endMs: number }[] = [];
    const colByMember: number[] = [];

    for (const { item } of members) {
      let placed = false;
      for (let lane = 0; lane < lanes.length; lane++) {
        // Back-to-back (prev ends exactly when next starts) reuses the lane.
        if (lanes[lane].endMs <= item.startMs) {
          lanes[lane].endMs = item.endMs;
          colByMember.push(lane);
          placed = true;
          break;
        }
      }
      if (!placed) {
        lanes.push({ endMs: item.endMs });
        colByMember.push(lanes.length - 1);
      }
    }

    const totalCols = Math.max(lanes.length, 1);
    members.forEach(({ i, item }, memberOrder) => {
      out[i] = {
        appointment: item.apt,
        topPct: item.topPct,
        heightPct: item.heightPct,
        col: colByMember[memberOrder],
        totalCols,
      };
    });
  }

  return out;
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
  const positioned: RawPositioned[] = [];
  for (const apt of appointments) {
    const start = safeParseISO(apt.booking_time);
    if (!start || !isSameDay(start, date)) continue;
    const pos = positionFor(apt);
    if (!pos) continue;
    const end =
      safeParseISO(apt.end_time) ??
      new Date(start.getTime() + 60 * 60 * 1000);
    positioned.push({
      apt,
      topPct: pos.topPct,
      heightPct: pos.heightPct,
      startMs: start.getTime(),
      endMs: end.getTime(),
    });
  }
  return packLanes(positioned);
}

/** Filter time blocks to a single local day with timeline positioning. */
export function layoutBlocksForDay(
  date: Date,
  blocks: TimeBlock[]
): PositionedTimeBlock[] {
  const positioned: PositionedTimeBlock[] = [];
  for (const block of blocks) {
    const start = safeParseISO(block.start_time);
    const end = safeParseISO(block.end_time);
    if (!start || !end || !isSameDay(start, date)) continue;
    const pos = positionInterval(start, end);
    if (!pos) continue;
    positioned.push({ block, topPct: pos.topPct, heightPct: pos.heightPct });
  }
  return positioned.sort((a, b) => a.topPct - b.topPct);
}
