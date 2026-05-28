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

/** Parse Cal.com v1 /slots JSON into UTC ISO strings for the selected day. */
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
