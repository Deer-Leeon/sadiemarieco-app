/**
 * Cal.com configuration for server-side booking (manual admin + proxies).
 * Keys use `site_services.slug` and `title` so admin UI does not hardcode IDs.
 */

import { sql } from '@vercel/postgres';

import { STUDIO_TIMEZONE } from '@/app/admin/availability/calSchedules';

export { STUDIO_TIMEZONE };

export const CAL_V1_BASE = 'https://api.cal.com/v1';

/**
 * Minutes blocked on the Cal.com calendar after each booking ends.
 * `0` allows back-to-back slots (60 min at 10:00 → next slot at 11:00).
 * Applied on create/update via `/api/admin/services` and cleared on admin reconcile.
 */
export const CAL_AFTER_EVENT_BUFFER_MIN = 0;

/**
 * Minimum lead time before a slot may be booked (Cal v2 `minimumBookingNotice`).
 */
export const CAL_MIN_BOOKING_NOTICE_MIN = 30;

/**
 * Spacing between offered start times (Cal v2 `slotInterval`), in minutes.
 * Independent of `lengthInMinutes` — a 90-minute service still shows
 * 10:00, 10:30, 11:00, …; Cal blocks overlapping slots when one is booked.
 */
export const CAL_SLOT_INTERVAL_MIN = 30;

/** Studio address shown on Cal.com in-person event types. */
export const STUDIO_IN_PERSON_ADDRESS =
  '61 W 3200 N, Suite #10, Lehi, UT 84043';

/** Cal v2 location object — In Person (Organizer Address). */
export const CAL_STUDIO_IN_PERSON_LOCATION = {
  type: 'address' as const,
  address: STUDIO_IN_PERSON_ADDRESS,
  public: true,
};

/**
 * The hidden admin override event type is configured for Cal Video only
 * (`integration`, not `address`). Time blocks and shadow-event fallbacks
 * must use this location shape or Cal rejects the create.
 */
export const CAL_ADMIN_OVERRIDE_BOOKING_LOCATION = {
  type: 'integration' as const,
  integration: 'cal-video' as const,
};

/** Auto-confirm bookings (no Cal.com "requires confirmation" / pending checkout gate). */
export const CAL_CONFIRMATION_POLICY_DISABLED = {
  disabled: true as const,
};

/**
 * Admin manual-booking god-mode: quarter-hour start times when probing Cal slots.
 * Cal uses `duration` for both gap length and step unless the event has
 * interval on the shadow Cal event type; we post-filter slot starts when needed.
 */
export const ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN = 15;

/** Manual-booking shadow schedule: studio open through 9 PM (America/Denver). */
export const ADMIN_MANUAL_BOOKING_DAY_START_MIN = 9 * 60;

export const ADMIN_MANUAL_BOOKING_DAY_END_MIN = 21 * 60;

/** Stable slug keys for bookable services (matches `site_services.slug`). */
export type CalServiceSlug = string;

export interface CalServiceBookingConfig {
  slug: string;
  title: string;
  category: string;
  parentId: number | null;
  eventTypeId: number;
  durationMins: number | null;
}

export interface CalServiceGroupHeader {
  id: number;
  title: string;
  category: string;
}

export interface CalEventTypeMaps {
  bySlug: Record<string, number>;
  byTitle: Record<string, number>;
  services: CalServiceBookingConfig[];
  groupHeaders: CalServiceGroupHeader[];
}

/**
 * Server-side API key — never expose to the client.
 * Supports `CALCOM_API_KEY` (spec) with `CAL_API_KEY` fallback (existing env).
 */
export function getCalComApiKey(): string | null {
  const key =
    process.env.CALCOM_API_KEY?.trim() || process.env.CAL_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/**
 * Hidden Cal event type with 9 AM–9 PM availability for admin slot picking only.
 * Bookings are created on each service's real Cal event (correct title/location
 * in Cal emails); this shadow type is a fallback when host-bypass create fails.
 * Enable "Offer multiple durations" and list every service length on the shadow
 * event for fallback lengthInMinutes.
 */
export const getAdminOverrideEventId = () =>
  process.env.CAL_ADMIN_OVERRIDE_EVENT_ID;

/** Parsed override id, or null when unset / invalid. */
export function parseAdminOverrideEventId(): number | null {
  const raw = getAdminOverrideEventId()?.trim();
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Allowed `lengthInMinutes` values on the admin override Cal event type
 * (multi-duration / "Offer multiple durations"). Long blocks are split into
 * consecutive bookings using these lengths — keep in sync with Cal.com.
 */
export const CAL_ADMIN_OVERRIDE_BLOCK_DURATIONS_MIN = [
  30, 45, 60, 80, 90, 120, 150, 180,
] as const;

export interface ServiceByCalEventId {
  title: string;
  duration_mins: number;
}

/** Resolve the bookable service row for a Cal.com event type id (manual booking). */
export async function loadServiceByCalEventId(
  calEventId: number
): Promise<ServiceByCalEventId | null> {
  const { rows } = await sql<{
    title: string;
    duration_mins: number | null;
  }>`
    SELECT title, duration_mins
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND cal_event_id = ${calEventId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.duration_mins == null || row.duration_mins <= 0) {
    return null;
  }
  return { title: row.title, duration_mins: row.duration_mins };
}

/**
 * Load active bookable services from Postgres and build lookup maps.
 * Call from Server Components or API routes when the admin UI needs IDs.
 */
export async function loadCalEventTypeMaps(): Promise<CalEventTypeMaps> {
  const [{ rows }, { rows: groupRows }] = await Promise.all([
    sql<{
      slug: string;
      title: string;
      category: string;
      parent_id: number | null;
      cal_event_id: number;
      duration_mins: number | null;
    }>`
      SELECT slug, title, category, parent_id, cal_event_id, duration_mins
      FROM site_services
      WHERE is_active = TRUE
        AND is_group = FALSE
        AND cal_event_id IS NOT NULL
        AND slug IS NOT NULL
      ORDER BY display_order ASC, id ASC
    `,
    sql<{
      id: number;
      title: string;
      category: string;
    }>`
      SELECT id, title, category
      FROM site_services
      WHERE is_active = TRUE
        AND is_group = TRUE
      ORDER BY display_order ASC, id ASC
    `,
  ]);

  const services: CalServiceBookingConfig[] = rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    category: row.category,
    parentId: row.parent_id,
    eventTypeId: row.cal_event_id,
    durationMins: row.duration_mins,
  }));

  const groupHeaders: CalServiceGroupHeader[] = groupRows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
  }));

  const bySlug: Record<string, number> = {};
  const byTitle: Record<string, number> = {};
  for (const s of services) {
    bySlug[s.slug] = s.eventTypeId;
    byTitle[s.title] = s.eventTypeId;
  }

  return { bySlug, byTitle, services, groupHeaders };
}

/** Resolve an internal service key (slug or display title) to a Cal event type id. */
export function resolveCalEventTypeId(
  serviceKey: string,
  maps: Pick<CalEventTypeMaps, 'bySlug' | 'byTitle'>
): number | null {
  const key = serviceKey.trim();
  if (!key) return null;
  if (maps.bySlug[key] != null) return maps.bySlug[key];
  if (maps.byTitle[key] != null) return maps.byTitle[key];
  return null;
}
