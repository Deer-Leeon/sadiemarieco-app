/**
 * Public bookable starts from Cal working hours minus live chair occupancy.
 *
 * Cal.com /slots also subtracts busy events on the connected calendar.
 * Cancelled test bookings often leave those events behind, so the website
 * would hide times the Bookings tab shows as empty. Occupancy here is
 * Postgres only: confirmed / pending / no-show appointments and time
 * blocks. Canceled rows do not occupy.
 */

import { sql } from '@vercel/postgres';

import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';

import {
  fetchDefaultScheduleCached,
  isUnavailableOverride,
  type DayName,
  type Schedule,
  type ScheduleOverride,
} from '@/app/admin/availability/calSchedules';
import {
  CAL_MIN_BOOKING_NOTICE_MIN,
  CAL_SLOT_INTERVAL_MIN,
  getCalComApiKey,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import { addCalendarDays, studioLocalDateKey } from '@/lib/cal-slot-dates';
import { parseBookingStartForCal } from '@/lib/cal-timezone';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BusyInterval {
  startMs: number;
  endMs: number;
}

interface DayWindow {
  startMin: number;
  endMin: number;
}

function hhmmToMinutes(hhmm: string): number {
  const [hRaw, mRaw] = hhmm.split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function studioWeekdayName(ymd: string): DayName {
  const probe = new Date(`${ymd}T18:00:00.000Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'long',
  }).format(probe);
  return name as DayName;
}

function overrideForDate(
  overrides: ScheduleOverride[],
  ymd: string
): ScheduleOverride | undefined {
  for (let i = overrides.length - 1; i >= 0; i -= 1) {
    if (overrides[i]?.date === ymd) return overrides[i];
  }
  return undefined;
}

export function windowsForStudioDate(
  schedule: Schedule,
  ymd: string
): DayWindow[] {
  const override = overrideForDate(schedule.overrides, ymd);
  if (override) {
    if (isUnavailableOverride(override)) return [];
    const startMin = hhmmToMinutes(override.startTime);
    const endMin = hhmmToMinutes(override.endTime);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      return [];
    }
    return [{ startMin, endMin }];
  }

  const dayName = studioWeekdayName(ymd);
  const windows: DayWindow[] = [];
  for (const block of schedule.availability) {
    if (!block.days.includes(dayName)) continue;
    const startMin = hhmmToMinutes(block.startTime);
    const endMin = hhmmToMinutes(block.endTime);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      continue;
    }
    windows.push({ startMin, endMin });
  }
  return windows;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function intervalMsFromSql(value: Date | string | null): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function loadStudioBusyIntervals(
  rangeStart: Date,
  rangeEnd: Date
): Promise<BusyInterval[]> {
  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();
  const busy: BusyInterval[] = [];

  await ensureAppointmentAttachedSchema();
  const { rows: appointments } = await sql<{
    booking_time: Date | string | null;
    end_time: Date | string | null;
  }>`
    SELECT booking_time, end_time
    FROM appointments
    WHERE booking_time IS NOT NULL
      AND LOWER(COALESCE(status, '')) IN (
        'pending',
        'confirmed',
        'accepted',
        'no-show'
      )
      AND attached_to_appointment_id IS NULL
      AND booking_time < ${endIso}
      AND COALESCE(end_time, booking_time) > ${startIso}
  `;

  for (const row of appointments) {
    const startMs = intervalMsFromSql(row.booking_time);
    if (startMs == null) continue;
    const endMs = intervalMsFromSql(row.end_time) ?? startMs;
    if (endMs <= startMs) continue;
    busy.push({ startMs, endMs });
  }

  const { rows: blocks } = await sql<{
    start_time: Date | string;
    end_time: Date | string;
  }>`
    SELECT start_time, end_time
    FROM studio_time_blocks
    WHERE start_time < ${endIso}
      AND end_time > ${startIso}
  `;

  for (const row of blocks) {
    const startMs = intervalMsFromSql(row.start_time);
    const endMs = intervalMsFromSql(row.end_time);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    busy.push({ startMs, endMs });
  }

  return busy;
}

function slotConflicts(startMs: number, endMs: number, busy: BusyInterval[]): boolean {
  return busy.some((b) => overlaps(startMs, endMs, b.startMs, b.endMs));
}

export function enumerateOpenStarts(args: {
  ymd: string;
  durationMins: number;
  windows: DayWindow[];
  busy: BusyInterval[];
  earliestStartMs: number;
  slotIntervalMins?: number;
}): string[] {
  const step = args.slotIntervalMins ?? CAL_SLOT_INTERVAL_MIN;
  const starts: string[] = [];
  const seen = new Set<number>();

  for (const window of args.windows) {
    const lastStartMin = window.endMin - args.durationMins;
    for (let minute = window.startMin; minute <= lastStartMin; minute += step) {
      if ((minute - window.startMin) % step !== 0) continue;
      const local = `${args.ymd}T${minutesToHhmm(minute)}:00`;
      let startUtc: Date;
      try {
        startUtc = parseBookingStartForCal(local);
      } catch {
        continue;
      }
      const startMs = startUtc.getTime();
      if (startMs < args.earliestStartMs) continue;
      const endMs = startMs + args.durationMins * 60_000;
      if (seen.has(startMs) || slotConflicts(startMs, endMs, args.busy)) continue;
      seen.add(startMs);
      starts.push(startUtc.toISOString());
    }
  }

  starts.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return starts;
}

export async function loadStudioSchedule(): Promise<
  { ok: true; schedule: Schedule } | { ok: false; message: string }
> {
  const apiKey = getCalComApiKey();
  if (!apiKey) {
    return { ok: false, message: 'Cal.com API key is not configured' };
  }
  try {
    const schedule = await fetchDefaultScheduleCached(apiKey);
    return { ok: true, schedule };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listStudioAvailableSlots(args: {
  rangeStartYmd: string;
  rangeEndYmd: string;
  durationMins: number;
}): Promise<
  { ok: true; slots: Record<string, string[]> } | { ok: false; message: string }
> {
  if (!ISO_DATE_RE.test(args.rangeStartYmd) || !ISO_DATE_RE.test(args.rangeEndYmd)) {
    return { ok: false, message: 'date must be YYYY-MM-DD' };
  }
  if (args.rangeEndYmd < args.rangeStartYmd) {
    return { ok: false, message: 'end must be on or after date' };
  }
  if (!Number.isFinite(args.durationMins) || args.durationMins <= 0) {
    return { ok: false, message: 'duration is invalid' };
  }

  const loaded = await loadStudioSchedule();
  if (!loaded.ok) return loaded;

  const rangeStart = parseBookingStartForCal(`${args.rangeStartYmd}T00:00:00`);
  const rangeEnd = parseBookingStartForCal(
    `${addCalendarDays(args.rangeEndYmd, 1)}T00:00:00`
  );
  const busy = await loadStudioBusyIntervals(rangeStart, rangeEnd);
  const earliestStartMs = Date.now() + CAL_MIN_BOOKING_NOTICE_MIN * 60_000;

  const slots: Record<string, string[]> = {};
  let cursor = args.rangeStartYmd;
  while (cursor <= args.rangeEndYmd) {
    const windows = windowsForStudioDate(loaded.schedule, cursor);
    const times = enumerateOpenStarts({
      ymd: cursor,
      durationMins: args.durationMins,
      windows,
      busy,
      earliestStartMs,
    });
    if (times.length > 0) slots[cursor] = times;
    cursor = addCalendarDays(cursor, 1);
  }

  return { ok: true, slots };
}

export async function studioSlotIsOpen(args: {
  startUtc: Date;
  durationMins: number;
}): Promise<boolean> {
  const ymd = studioLocalDateKey(args.startUtc.toISOString());
  if (!ISO_DATE_RE.test(ymd)) return false;

  const listed = await listStudioAvailableSlots({
    rangeStartYmd: ymd,
    rangeEndYmd: ymd,
    durationMins: args.durationMins,
  });
  if (!listed.ok) return false;

  const startMs = args.startUtc.getTime();
  const times = listed.slots[ymd] ?? [];
  return times.some((iso) => {
    const other = new Date(iso).getTime();
    return Number.isFinite(other) && Math.abs(other - startMs) < 60_000;
  });
}
