/**
 * Group Cal slot instants by studio-local calendar date (America/Denver).
 * Cal.com buckets evening MT slots under the next UTC day; regrouping fixes
 * "missing" afternoon/evening times on the last day of a month.
 */

import { STUDIO_TIMEZONE } from '@/app/admin/availability/calSchedules';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function studioLocalDateKey(isoUtc: string): string {
  const ms = new Date(isoUtc).getTime();
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
  }).format(new Date(ms));
}

/** Add calendar days to a YYYY-MM-DD string (UTC calendar math). */
export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function regroupSlotTimesByStudioDate(
  slots: Record<string, string[]>
): Record<string, string[]> {
  const buckets: Record<string, string[]> = {};

  for (const times of Object.values(slots)) {
    for (const iso of times) {
      const studioDate = studioLocalDateKey(iso);
      if (!ISO_DATE_RE.test(studioDate)) continue;
      if (!buckets[studioDate]) buckets[studioDate] = [];
      buckets[studioDate].push(iso);
    }
  }

  for (const date of Object.keys(buckets)) {
    const seen = new Set<number>();
    buckets[date] = buckets[date]
      .filter((iso) => {
        const ms = new Date(iso).getTime();
        if (Number.isNaN(ms) || seen.has(ms)) return false;
        seen.add(ms);
        return true;
      })
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  }

  return buckets;
}

/** Keep only studio dates within [start, end] inclusive. */
export function filterSlotMapByStudioDateRange(
  slots: Record<string, string[]>,
  start: string,
  end: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [date, times] of Object.entries(slots)) {
    if (date < start || date > end) continue;
    if (times.length > 0) out[date] = times;
  }
  return out;
}
