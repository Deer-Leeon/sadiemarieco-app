/**
 * Shared appointment duration helpers (manual booking shadow event + webhooks).
 */

import { ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN } from '@/lib/cal-config';

function hasContiguousFineAvailability(
  fineMs: Set<number>,
  startMs: number,
  requiredSteps: number,
  stepMs: number
): boolean {
  for (let j = 0; j < requiredSteps; j++) {
    if (!fineMs.has(startMs + j * stepMs)) return false;
  }
  return true;
}

/**
 * From 15-minute Cal probes, keep starts where every quarter-hour step through
 * `serviceDurationMins` is open. Uses a timestamp set (not array adjacency) so
 * a missing intermediate slot in Cal's array does not false-negative.
 */
export function slotStartsFromFineGrid(
  slots: Record<string, string[]>,
  serviceDurationMins: number,
  slotIntervalMins: number = ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN
): Record<string, string[]> {
  const required = Math.max(
    1,
    Math.ceil(serviceDurationMins / slotIntervalMins)
  );
  const stepMs = slotIntervalMins * 60_000;
  const filtered: Record<string, string[]> = {};

  for (const [date, times] of Object.entries(slots)) {
    const fineMs = new Set(
      times
        .map((iso) => new Date(iso).getTime())
        .filter((ms) => !Number.isNaN(ms))
    );
    const valid: string[] = [];

    for (const startMs of fineMs) {
      if (hasContiguousFineAvailability(fineMs, startMs, required, stepMs)) {
        valid.push(new Date(startMs).toISOString());
      }
    }

    if (valid.length > 0) {
      valid.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      filtered[date] = valid;
    }
  }

  return filtered;
}

/** @deprecated Use slotStartsFromFineGrid — kept as alias for callers. */
export function filterSlotStartsForServiceDuration(
  slots: Record<string, string[]>,
  serviceDurationMins: number,
  slotIntervalMins?: number
): Record<string, string[]> {
  return slotStartsFromFineGrid(slots, serviceDurationMins, slotIntervalMins);
}

export function mergeSlotIsoLists(a: string[], b: string[]): string[] {
  const seen = new Set<number>();
  const merged: string[] = [];

  for (const iso of [...a, ...b]) {
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms) || seen.has(ms)) continue;
    seen.add(ms);
    merged.push(new Date(ms).toISOString());
  }

  merged.sort((x, y) => new Date(x).getTime() - new Date(y).getTime());
  return merged;
}

/** Union slot lists per day (deduped by instant). */
export function mergeSlotDays(
  ...maps: Record<string, string[]>[]
): Record<string, string[]> {
  const dates = new Set(maps.flatMap((m) => Object.keys(m)));
  const out: Record<string, string[]> = {};

  for (const date of dates) {
    let merged: string[] = [];
    for (const m of maps) {
      merged = mergeSlotIsoLists(merged, m[date] ?? []);
    }
    if (merged.length > 0) out[date] = merged;
  }

  return out;
}

export function bookingEndFromDurationMins(
  startIso: string,
  durationMins: number | null | undefined
): string | null {
  if (durationMins == null || durationMins <= 0) return null;
  const startMs = new Date(startIso).getTime();
  if (Number.isNaN(startMs)) return null;
  return new Date(startMs + durationMins * 60_000).toISOString();
}

export interface ManualBookingShadowMetadata {
  isManualAdmin: boolean;
  originalServiceName: string | null;
  durationMins: number | null;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const raw = metadata[key];
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const v = (raw as { value: unknown }).value;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/** Parse Cal booking metadata set by admin manual-booking create. */
export function parseManualBookingShadowMetadata(
  metadata: unknown
): ManualBookingShadowMetadata {
  if (!metadata || typeof metadata !== 'object') {
    return {
      isManualAdmin: false,
      originalServiceName: null,
      durationMins: null,
    };
  }

  const record = metadata as Record<string, unknown>;
  const originalServiceName = metadataString(record, 'original_service_name');
  const durationRaw = metadataString(record, 'original_service_duration_mins');
  const durationParsed = durationRaw ? Number(durationRaw) : NaN;
  const durationMins =
    Number.isFinite(durationParsed) && durationParsed > 0
      ? durationParsed
      : null;

  return {
    isManualAdmin: metadataString(record, 'manual_admin_booking') === 'true',
    originalServiceName,
    durationMins,
  };
}

/**
 * Resolve service title and end time when a shadow Cal event was used.
 * Prefers metadata from create; falls back to Cal payload fields.
 */
export function resolveShadowAppointmentFields(input: {
  calTitle: string | null;
  bookingTime: string | null;
  endTime: string | null;
  metadata: unknown;
}): {
  serviceName: string;
  bookingTime: string | null;
  endTime: string | null;
} {
  const { isManualAdmin, originalServiceName, durationMins } =
    parseManualBookingShadowMetadata(input.metadata);

  const serviceName =
    originalServiceName?.trim() ||
    input.calTitle?.trim() ||
    'appointment';

  let endTime = input.endTime;
  const bookingTime = input.bookingTime;

  if (
    isManualAdmin &&
    originalServiceName &&
    durationMins != null &&
    bookingTime
  ) {
    const computed = bookingEndFromDurationMins(bookingTime, durationMins);
    if (computed) endTime = computed;
  }

  return { serviceName, bookingTime, endTime };
}
