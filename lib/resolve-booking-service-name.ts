function unwrap(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const nested = (val as { value?: unknown }).value;
    if (typeof nested === 'string') return nested;
  }
  return String(val);
}

/** Human-readable service label from a Cal.com webhook payload. */
export function resolveBookingServiceName(
  payload: Record<string, unknown>,
): string {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {};

  const shadowName = unwrap(metadata.original_service_name);
  if (shadowName) return shadowName;

  const eventTitle = unwrap(payload.eventTitle);
  if (eventTitle) return eventTitle;

  const title = unwrap(payload.title);
  if (title) {
    const short = title.split(/\s+between\s+/i)[0]?.trim();
    if (short) return short;
    return title;
  }

  return unwrap(payload.type) || 'appointment';
}
