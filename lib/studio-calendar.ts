/**
 * America/Denver calendar-day + wall-clock helpers for the admin bookings UI.
 *
 * date-fns `isToday` / `isSameDay` / `format` follow the JS runtime timezone.
 * Vercel SSR runs in UTC, so after ~6pm Mountain those helpers already treat
 * "today" as the next calendar day and shift evening appointments. Always use
 * these for day buckets, "today" chrome, timeline math, and clock labels.
 */

import { STUDIO_TIMEZONE } from '@/lib/cal-config';

export { STUDIO_TIMEZONE };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StudioZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function studioZonedParts(date: Date): StudioZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** YYYY-MM-DD in America/Denver for an instant (or ISO string). */
export function studioDateKey(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
  }).format(d);
}

export function todayStudioDateKey(): string {
  return studioDateKey(new Date());
}

export function isStudioToday(input: Date | string): boolean {
  const key = typeof input === 'string' && ISO_DATE_RE.test(input)
    ? input
    : studioDateKey(input);
  return Boolean(key) && key === todayStudioDateKey();
}

export function isSameStudioDay(
  a: Date | string,
  b: Date | string
): boolean {
  const ka =
    typeof a === 'string' && ISO_DATE_RE.test(a) ? a : studioDateKey(a);
  const kb =
    typeof b === 'string' && ISO_DATE_RE.test(b) ? b : studioDateKey(b);
  return Boolean(ka && kb && ka === kb);
}

/**
 * Stable Date for a studio calendar day (UTC noon). Safe for weekday math
 * via `getUTCDay()` and for React keys — not a real studio midnight instant.
 */
export function calendarDayUtcNoon(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function addStudioCalendarDays(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days, 12));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** First day of the studio month containing `yyyyMmDd` (or today). */
export function startOfStudioMonthKey(yyyyMmDd?: string): string {
  const key = yyyyMmDd ?? todayStudioDateKey();
  return `${key.slice(0, 7)}-01`;
}

export function studioMonthKey(yyyyMmDd: string): string {
  return yyyyMmDd.slice(0, 7);
}

/** Days in the Gregorian month of a YYYY-MM-DD key. */
export function daysInStudioMonth(yyyyMmDd: string): number {
  const y = Number(yyyyMmDd.slice(0, 4));
  const m = Number(yyyyMmDd.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0=Sun..6=Sat for a studio calendar day. */
export function studioWeekdaySun0(yyyyMmDd: string): number {
  return calendarDayUtcNoon(yyyyMmDd).getUTCDay();
}

/** Wall-clock minutes since studio midnight (DST-safe via zoned parts). */
export function studioMinutesFromMidnight(date: Date): number {
  const p = studioZonedParts(date);
  return p.hour * 60 + p.minute + p.second / 60;
}

/** Admin clock label matching prior date-fns `h:mm a` style ("2:00 PM"). */
export function formatStudioClock(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

export function formatStudioClockRange(
  start: Date | string,
  end?: Date | string | null
): string {
  const startLabel = formatStudioClock(start);
  if (!startLabel) return '';
  if (end == null || end === '') return startLabel;
  const endLabel = formatStudioClock(end);
  return endLabel ? `${startLabel} – ${endLabel}` : startLabel;
}

export function formatStudioDateLong(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatStudioDateShort(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

export function formatStudioMonthYear(input: Date | string): string {
  const d =
    typeof input === 'string' && ISO_DATE_RE.test(input)
      ? calendarDayUtcNoon(input)
      : typeof input === 'string'
        ? new Date(input)
        : input;
  if (Number.isNaN(d.getTime())) return '';
  // UTC noon calendar-day keys: format in UTC so month/year don't shift.
  if (typeof input === 'string' && ISO_DATE_RE.test(input)) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(d);
}

export function formatStudioDayOfMonth(input: Date | string): string {
  if (typeof input === 'string' && ISO_DATE_RE.test(input)) {
    return String(Number(input.slice(8, 10)));
  }
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    day: 'numeric',
  }).format(d);
}

export function formatStudioWeekdayShort(input: Date | string): string {
  const d =
    typeof input === 'string' && ISO_DATE_RE.test(input)
      ? calendarDayUtcNoon(input)
      : typeof input === 'string'
        ? new Date(input)
        : input;
  if (Number.isNaN(d.getTime())) return '';
  const timeZone =
    typeof input === 'string' && ISO_DATE_RE.test(input)
      ? 'UTC'
      : STUDIO_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(d);
}

/** "Jul 30" / "Jul 30, 2026" style range pieces for DateNav. */
export function formatStudioNavDay(
  yyyyMmDd: string,
  opts?: { includeYear?: boolean }
): string {
  const d = calendarDayUtcNoon(yyyyMmDd);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(opts?.includeYear ? { year: 'numeric' as const } : {}),
  }).format(d);
}
