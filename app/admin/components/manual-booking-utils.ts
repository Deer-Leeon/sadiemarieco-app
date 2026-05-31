/**
 * Client-side helpers for the manual booking wizard.
 */

import { bookingEndFromDurationMins } from '@/lib/booking-duration';

export const STUDIO_TIMEZONE = 'America/Denver';

/** Keep in sync with `CAL_MIN_BOOKING_NOTICE_MIN` in lib/cal-config.ts */
export const MANUAL_BOOKING_MIN_NOTICE_MIN = 30;

export interface ManualBookingServiceOption {
  slug: string;
  title: string;
  category: string;
  parentId: number | null;
  eventTypeId: number;
  durationMins: number | null;
}

export interface ManualBookingServiceGroupHeader {
  id: number;
  title: string;
  category: string;
}

export type ManualBookingCategoryRow =
  | { kind: 'standalone'; service: ManualBookingServiceOption }
  | {
      kind: 'group';
      groupId: number;
      groupTitle: string;
      children: ManualBookingServiceOption[];
    };

export interface ManualBookingServiceCategoryGroup {
  category: string;
  rows: ManualBookingCategoryRow[];
  /** Empty placeholder category (e.g. Teeth Whitening) — not bookable yet */
  comingSoon: boolean;
}

/** Homepage / admin catalogue column order — keep aligned with app/route.ts */
export const MANUAL_BOOKING_CATEGORY_COLUMN_RANK: Record<string, number> = {
  'Lash Services': 0,
  'Brow Services': 1,
  'Teeth Whitening': 2,
};

/** Keep in sync with `COMING_SOON_CATEGORIES` in app/route.ts */
export const MANUAL_BOOKING_COMING_SOON_CATEGORIES = new Set([
  'Teeth Whitening',
]);

function buildCategoryRows(
  bookable: ManualBookingServiceOption[],
  groupTitleById: Map<number, string>
): ManualBookingCategoryRow[] {
  const groupIds = new Set(groupTitleById.keys());
  const childrenByParent = new Map<number, ManualBookingServiceOption[]>();

  for (const service of bookable) {
    if (service.parentId !== null && groupIds.has(service.parentId)) {
      const list = childrenByParent.get(service.parentId);
      if (list) list.push(service);
      else childrenByParent.set(service.parentId, [service]);
    }
  }

  const rows: ManualBookingCategoryRow[] = [];
  const emittedGroups = new Set<number>();

  for (const service of bookable) {
    if (service.parentId !== null && groupIds.has(service.parentId)) {
      const parentId = service.parentId;
      if (!emittedGroups.has(parentId)) {
        emittedGroups.add(parentId);
        rows.push({
          kind: 'group',
          groupId: parentId,
          groupTitle: groupTitleById.get(parentId) ?? 'Service group',
          children: childrenByParent.get(parentId) ?? [],
        });
      }
      continue;
    }

    rows.push({ kind: 'standalone', service });
  }

  return rows;
}

/**
 * Build category sections with nested service groups (mirrors public menu order).
 * `services` must already be sorted by display_order; `groupHeaders` supply labels.
 */
export function buildManualBookingServiceMenu(
  services: ManualBookingServiceOption[],
  groupHeaders: ManualBookingServiceGroupHeader[]
): ManualBookingServiceCategoryGroup[] {
  const byCategory = new Map<string, ManualBookingServiceOption[]>();
  for (const service of services) {
    const list = byCategory.get(service.category);
    if (list) list.push(service);
    else byCategory.set(service.category, [service]);
  }

  const groupsByCategory = new Map<string, Map<number, string>>();
  for (const group of groupHeaders) {
    let map = groupsByCategory.get(group.category);
    if (!map) {
      map = new Map();
      groupsByCategory.set(group.category, map);
    }
    map.set(group.id, group.title);
  }

  const categories = new Set([
    ...byCategory.keys(),
    ...MANUAL_BOOKING_COMING_SOON_CATEGORIES,
  ]);

  return Array.from(categories)
    .sort((a, b) => {
      const rankA = MANUAL_BOOKING_CATEGORY_COLUMN_RANK[a] ?? 50;
      const rankB = MANUAL_BOOKING_CATEGORY_COLUMN_RANK[b] ?? 50;
      if (rankA !== rankB) return rankA - rankB;
      return a.localeCompare(b);
    })
    .map((category) => {
      const items = byCategory.get(category) ?? [];
      const rows = buildCategoryRows(
        items,
        groupsByCategory.get(category) ?? new Map()
      );
      return {
        category,
        rows,
        comingSoon:
          MANUAL_BOOKING_COMING_SOON_CATEGORIES.has(category) &&
          rows.length === 0,
      };
    });
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

/** Drop past slots and enforce minimum lead time on the selected studio day. */
export function filterSlotsForBookingDay(
  slots: string[],
  date: string,
  todayStudio: string
): string[] {
  const minMs =
    date === todayStudio
      ? Date.now() + MANUAL_BOOKING_MIN_NOTICE_MIN * 60_000
      : 0;

  return slots.filter((iso) => {
    const ms = new Date(iso).getTime();
    return !Number.isNaN(ms) && ms >= minMs;
  });
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

/** Split a full name — first token is first name, remainder is last name. */
export function splitFullName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first: parts[0] ?? '',
    last: parts.slice(1).join(' '),
  };
}

export function joinFullName(first: string, last: string): string {
  return [first.trim(), last.trim()].filter(Boolean).join(' ');
}

/** End time from start + service duration (used when Cal override event has fixed length). */
export function bookingEndFromDuration(
  startIso: string,
  durationMins: number | null
): string | null {
  return bookingEndFromDurationMins(startIso, durationMins);
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
