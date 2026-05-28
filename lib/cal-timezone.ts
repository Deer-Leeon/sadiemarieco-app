/**
 * Mountain Time helpers for Cal.com manual bookings (studio is in Lehi, UT).
 */

import { STUDIO_TIMEZONE } from '@/lib/cal-config';

const LOCAL_START_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export class CalStartTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalStartTimeError';
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
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

function partsToUtcMs(parts: ZonedParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

/**
 * Convert wall-clock components in `timeZone` to a UTC Date.
 * Iterates until the zoned representation matches (handles DST).
 */
function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  let utcMs = partsToUtcMs(parts);
  for (let i = 0; i < 4; i++) {
    const actual = zonedParts(new Date(utcMs), timeZone);
    const diff =
      partsToUtcMs(parts) -
      Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second
      );
    if (diff === 0) break;
    utcMs += diff;
  }
  return new Date(utcMs);
}

/**
 * Parse `start` for Cal.com:
 * - Values with `Z` or a numeric offset are absolute instants.
 * - Bare `YYYY-MM-DDTHH:mm[:ss]` values are interpreted as studio local time.
 */
export function parseBookingStartForCal(start: string): Date {
  const trimmed = start.trim();
  if (!trimmed) {
    throw new CalStartTimeError('start is required');
  }

  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const instant = new Date(trimmed);
    if (Number.isNaN(instant.getTime())) {
      throw new CalStartTimeError('start is not a valid ISO datetime');
    }
    return instant;
  }

  const match = trimmed.match(LOCAL_START_RE);
  if (!match) {
    throw new CalStartTimeError(
      'start must be an ISO datetime (with offset/Z) or local YYYY-MM-DDTHH:mm in studio time'
    );
  }

  const [, y, mo, d, h, mi, sec = '00'] = match;
  return zonedTimeToUtc(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(sec),
    },
    STUDIO_TIMEZONE
  );
}

export function addMinutesUtc(start: Date, minutes: number): Date {
  return new Date(start.getTime() + minutes * 60_000);
}
