import { sql } from '@vercel/postgres';

export type ReminderServiceKind = 'brows' | 'lashes';

const BROWS_CATEGORIES = new Set(['Brow Services', 'Teeth Whitening']);
const AMBIGUOUS_LASH_TITLES = new Set(['classic', 'hybrid', 'volume']);

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

function toIsoTimestamp(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export interface ResolvedAppointmentService {
  displayName: string;
  category: string | null;
  reminderKind: ReminderServiceKind | null;
}

/**
 * Resolve the catalogue title + category for an appointment's stored
 * `service_name` (matches admin dashboard lateral join logic).
 */
export async function resolveAppointmentService(
  serviceName: string,
  bookingTime?: string | Date | null,
  endTime?: string | Date | null,
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
    const bookingIso = bookingTime ? toIsoTimestamp(bookingTime) : null;
    const endIso = endTime ? toIsoTimestamp(endTime) : null;
    const needsDurationMatch =
      AMBIGUOUS_LASH_TITLES.has(primary.toLowerCase().trim()) &&
      bookingIso &&
      endIso;

    const { rows } = needsDurationMatch
      ? await sql<{ title: string; category: string }>`
          SELECT s.title, s.category
          FROM site_services s
          WHERE s.title = ${primary}
            AND s.is_active = TRUE
            AND s.duration_mins IS NOT NULL
            AND s.duration_mins = GREATEST(
              1,
              ROUND(
                EXTRACT(
                  EPOCH FROM (${endIso}::timestamptz - ${bookingIso}::timestamptz)
                ) / 60.0
              )
            )::integer
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
        `
      : await sql<{ title: string; category: string }>`
          SELECT s.title, s.category
          FROM site_services s
          WHERE s.title = ${primary}
            AND s.is_active = TRUE
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
        `;

    const row = rows[0];
    if (!row) {
      return {
        displayName: fallbackName,
        category: null,
        reminderKind: null,
      };
    }

    return {
      displayName: row.title,
      category: row.category,
      reminderKind: reminderKindFromCategory(row.category),
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
