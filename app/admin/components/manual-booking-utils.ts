/**
 * Client-side helpers for the manual booking wizard.
 */

export const STUDIO_TIMEZONE = 'America/Denver';

export interface ManualBookingServiceOption {
  slug: string;
  title: string;
  eventTypeId: number;
  durationMins: number | null;
}

/** Dates (YYYY-MM-DD) that have at least one open slot in a normalized slots payload. */
export function datesWithOpenSlots(
  payload: unknown,
  options?: { notBefore?: string }
): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;
  const slots = root.slots;
  if (!slots || typeof slots !== 'object') return [];

  const minDate = options?.notBefore ?? '';

  return Object.entries(slots as Record<string, unknown>)
    .filter(([date, times]) => {
      if (minDate && date < minDate) return false;
      return Array.isArray(times) && times.length > 0;
    })
    .map(([date]) => date)
    .sort();
}

/** Parse Cal.com slots JSON (v1 shape or v2-normalized) into UTC ISO strings for the selected day. */
export function parseCalSlotTimes(payload: unknown, date: string): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;
  const slots = root.slots;
  if (!slots || typeof slots !== 'object') return [];

  const daySlots = (slots as Record<string, unknown>)[date];
  if (Array.isArray(daySlots)) {
    return daySlots.filter((t): t is string => typeof t === 'string');
  }

  if (daySlots && typeof daySlots === 'object') {
    const times = (daySlots as { time?: unknown }).time;
    if (Array.isArray(times)) {
      return times.filter((t): t is string => typeof t === 'string');
    }
  }

  return [];
}

export function formatSlotInStudioTime(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/**
 * Build a start value the API treats as studio-local wall time
 * (YYYY-MM-DDTHH:mm:ss with no offset).
 */
export function slotToStudioLocalStart(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid slot time');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';

  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function todayInStudio(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
  }).format(new Date());
}

/** Parse Cal v2 create-booking JSON for uid and times. */
export function extractCalBookingFromResponse(payload: unknown): {
  uid: string | null;
  startTime: string | null;
  endTime: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return { uid: null, startTime: null, endTime: null };
  }

  const root = payload as Record<string, unknown>;
  const booking =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root.booking && typeof root.booking === 'object'
        ? (root.booking as Record<string, unknown>)
        : root;

  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  return {
    uid: asString(booking.uid),
    startTime:
      asString(booking.startTime) ??
      asString(booking.start) ??
      null,
    endTime:
      asString(booking.endTime) ?? asString(booking.end) ?? null,
  };
}
