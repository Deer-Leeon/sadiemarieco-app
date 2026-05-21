/**
 * Cal.com formats event titles as "<service> between <organiser> and
 * <attendee>" — e.g. "Hybrid Full Set between Sadie Marie and Leon". Strip
 * the suffix so the dashboard shows just the service name.
 *
 * Case-insensitive and tolerates extra whitespace. Returns 'Appointment'
 * as a sensible fallback rather than empty string so the UI never has
 * a blank cell.
 */
export function cleanServiceName(name: string | null): string {
  if (!name) return 'Appointment';
  const cleaned = name.split(/\s+between\s+/i)[0].trim();
  return cleaned || 'Appointment';
}

/**
 * Compose a display name from first + last. Returns 'Unknown client'
 * rather than empty string so list rows always render something.
 */
export function clientDisplayName(
  first: string | null,
  last: string | null
): string {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || 'Unknown client';
}
