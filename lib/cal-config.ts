/**
 * Cal.com configuration for server-side booking (manual admin + proxies).
 * Keys use `site_services.slug` and `title` so admin UI does not hardcode IDs.
 */

import { sql } from '@vercel/postgres';

import { STUDIO_TIMEZONE } from '@/app/admin/availability/calSchedules';

export { STUDIO_TIMEZONE };

export const CAL_V1_BASE = 'https://api.cal.com/v1';

/** Stable slug keys for bookable services (matches `site_services.slug`). */
export type CalServiceSlug = string;

export interface CalServiceBookingConfig {
  slug: string;
  title: string;
  eventTypeId: number;
  durationMins: number | null;
}

export interface CalEventTypeMaps {
  bySlug: Record<string, number>;
  byTitle: Record<string, number>;
  services: CalServiceBookingConfig[];
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
 * Load active bookable services from Postgres and build lookup maps.
 * Call from Server Components or API routes when the admin UI needs IDs.
 */
export async function loadCalEventTypeMaps(): Promise<CalEventTypeMaps> {
  const { rows } = await sql<{
    slug: string;
    title: string;
    cal_event_id: number;
    duration_mins: number | null;
  }>`
    SELECT slug, title, cal_event_id, duration_mins
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND cal_event_id IS NOT NULL
      AND slug IS NOT NULL
    ORDER BY category ASC, title ASC
  `;

  const services: CalServiceBookingConfig[] = rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    eventTypeId: row.cal_event_id,
    durationMins: row.duration_mins,
  }));

  const bySlug: Record<string, number> = {};
  const byTitle: Record<string, number> = {};
  for (const s of services) {
    bySlug[s.slug] = s.eventTypeId;
    byTitle[s.title] = s.eventTypeId;
  }

  return { bySlug, byTitle, services };
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
