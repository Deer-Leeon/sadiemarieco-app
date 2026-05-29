/**
 * Shared appointment duration helpers (manual booking shadow event + webhooks).
 */

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
