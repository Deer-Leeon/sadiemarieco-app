import { sql } from '@vercel/postgres';

import {
  appointmentServiceTitleKey,
  appointmentServiceTitleKeyWithoutAddOn,
  BARE_FILL_TITLE_KEYS,
} from '@/lib/appointment-service-title-key';

export type CatalogueServiceRow = {
  title: string;
  color: string | null;
  duration_mins: number | null;
  slug: string | null;
  description: string | null;
  category?: string | null;
  cal_event_id?: number | null;
};

function durationMinutes(
  bookingTime: Date | string | null | undefined,
  endTime: Date | string | null | undefined,
): number | null {
  if (!bookingTime || !endTime) return null;
  const start = bookingTime instanceof Date ? bookingTime : new Date(bookingTime);
  const end = endTime instanceof Date ? endTime : new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
}

function primaryTitle(serviceName: string | null | undefined): string {
  if (!serviceName) return '';
  return serviceName.split(/\s+between\s+/i)[0]?.trim() ?? '';
}

/**
 * Pick the catalogue row for a Cal.com appointment title. Token-bag
 * matching ignores punctuation and word order so "Lamination, Tint, + Wax"
 * resolves to "Lamination, Wax, + Tint".
 */
export function matchCatalogueService(
  serviceName: string | null | undefined,
  bookingTime: Date | string | null | undefined,
  endTime: Date | string | null | undefined,
  catalogue: CatalogueServiceRow[],
  calEventTypeId?: number | null,
): CatalogueServiceRow | null {
  if (calEventTypeId != null) {
    const byId = catalogue.filter(
      (row) => Number(row.cal_event_id) === Number(calEventTypeId),
    );
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) {
      return (
        byId.find((row) => row.title.trim().toLowerCase() === primaryTitle(serviceName).toLowerCase()) ??
        byId[0]
      );
    }
  }

  const key = appointmentServiceTitleKey(serviceName);
  if (!key) return null;

  let matches = catalogue.filter(
    (row) => appointmentServiceTitleKey(row.title) === key,
  );

  if (matches.length === 0) {
    const stripped = appointmentServiceTitleKeyWithoutAddOn(serviceName);
    if (stripped && stripped !== key) {
      const addOnMatches = catalogue.filter(
        (row) => appointmentServiceTitleKey(row.title) === stripped,
      );
      if (addOnMatches.length === 1) matches = addOnMatches;
    }
  }

  if (matches.length === 0) return null;

  if (BARE_FILL_TITLE_KEYS.has(key)) {
    const mins = durationMinutes(bookingTime, endTime);
    if (mins != null) {
      const byDuration = matches.filter(
        (row) => Number(row.duration_mins) === mins,
      );
      if (byDuration.length > 0) matches = byDuration;
    }
  }

  const exact = primaryTitle(serviceName).toLowerCase();
  return (
    matches.find((row) => row.title.trim().toLowerCase() === exact) ??
    matches[0]
  );
}

export function applyCatalogueService(
  fields: {
    service_name: string | null;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    service_color: string | null;
    service_slug: string | null;
    service_description: string | null;
    cal_event_type_id?: number | null;
  },
  catalogue: CatalogueServiceRow[],
): {
  service_color: string | null;
  service_slug: string | null;
  service_description: string | null;
} {
  const matched = matchCatalogueService(
    fields.service_name,
    fields.booking_time,
    fields.end_time,
    catalogue,
    fields.cal_event_type_id,
  );
  return {
    service_color: fields.service_color ?? matched?.color ?? null,
    service_slug: fields.service_slug ?? matched?.slug ?? null,
    service_description: fields.service_description ?? matched?.description ?? null,
  };
}

export async function loadActiveCatalogueServices(): Promise<CatalogueServiceRow[]> {
  const { rows } = await sql<CatalogueServiceRow>`
    SELECT title, color, duration_mins, slug, description, category, cal_event_id
    FROM site_services
    WHERE is_active = TRUE
  `;
  return rows;
}
