import { sql } from '@vercel/postgres';

import { matchCatalogueService } from '@/lib/match-catalogue-service';

export type ReminderServiceKind = 'brows' | 'lashes';

const BROWS_CATEGORIES = new Set(['Brow Services', 'Teeth Whitening']);

export function reminderKindFromCategory(
  category: string | null | undefined,
): ReminderServiceKind | null {
  if (!category) return null;
  if (category === 'Lash Services') return 'lashes';
  if (BROWS_CATEGORIES.has(category)) return 'brows';
  return null;
}

/** Fallback when `site_services.category` cannot be resolved. */
export function inferReminderKindFromServiceName(
  serviceName: string,
): ReminderServiceKind | null {
  const lower = serviceName.toLowerCase();
  if (
    lower.includes('brow') ||
    lower.includes('lamination') ||
    lower.includes('whiten')
  ) {
    return 'brows';
  }
  if (lower.includes('lash')) return 'lashes';
  return null;
}

function primaryServiceTitle(serviceName: string): string {
  const trimmed = serviceName.trim();
  if (!trimmed) return '';
  const betweenIdx = trimmed.toLowerCase().indexOf(' between ');
  if (betweenIdx === -1) return trimmed;
  return trimmed.slice(0, betweenIdx).trim();
}

export interface ResolvedAppointmentService {
  displayName: string;
  category: string | null;
  reminderKind: ReminderServiceKind | null;
}

/**
 * Resolve the catalogue title + category for an appointment's stored
 * `service_name`. Uses the same token-bag match as calendar colours so
 * reordered Cal titles still hit the CMS row.
 */
export async function resolveAppointmentService(
  serviceName: string,
  bookingTime?: string | Date | null,
  endTime?: string | Date | null,
  calEventTypeId?: number | null,
): Promise<ResolvedAppointmentService> {
  const primary = primaryServiceTitle(serviceName);
  const fallbackName = primary || serviceName.trim() || 'appointment';

  if (!primary) {
    return {
      displayName: fallbackName,
      category: null,
      reminderKind: null,
    };
  }

  try {
    const { rows } = await sql<{
      title: string;
      category: string | null;
      duration_mins: number | null;
      color: string | null;
      slug: string | null;
      description: string | null;
      cal_event_id: number | null;
    }>`
      SELECT title, category, duration_mins, color, slug, description, cal_event_id
      FROM site_services
      WHERE is_active = TRUE
    `;
    const matched = matchCatalogueService(
      serviceName,
      bookingTime,
      endTime,
      rows,
      calEventTypeId,
    );
    if (!matched) {
      return {
        displayName: fallbackName,
        category: null,
        reminderKind: null,
      };
    }

    return {
      displayName: matched.title,
      category: matched.category ?? null,
      reminderKind: reminderKindFromCategory(matched.category),
    };
  } catch (err) {
    console.error('[appointment-service-lookup] lookup failed', {
      serviceName: primary,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      displayName: fallbackName,
      category: null,
      reminderKind: null,
    };
  }
}
