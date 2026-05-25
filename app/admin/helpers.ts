import type { ClientCrmStats } from './types';

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
 * Cal.com's nine fill-children all share three titles ("Classic" /
 * "Hybrid" / "Volume") with no week marker in either the title or
 * the slug, so `cleanServiceName` alone produces an ambiguous label
 * ("Classic") whether the booking is a 2-, 3-, or 4-Week Fill.
 *
 * This helper enriches the label by mirroring the duration-fallback
 * already used in `serviceColors.ts`: any bare Classic / Hybrid /
 * Volume row gets its fill-week prepended based on the appointment's
 * actual length (end_time − booking_time).
 *
 *   120 min  → "Classic 2 Week Fill"
 *   150 min  → "Hybrid 3 Week Fill"
 *   180 min  → "Volume 4 Week Fill"
 *
 * Format mirrors the existing "Classic Full Set" / "Hybrid Full Set"
 * pattern (lash-type first, then service-name) so the calendar
 * reads consistently across both families.
 *
 * Inputs that aren't bare fill children — or that have missing /
 * malformed timestamps — fall straight through to `cleanServiceName`
 * unchanged. Full Sets are 180 min too, but they never enter the
 * disambiguation branch because their title contains "Full Set".
 */
export function appointmentServiceLabel(input: {
  service_name: string | null;
  booking_time?: string | null;
  end_time?: string | null;
}): string {
  const base = cleanServiceName(input.service_name);
  const baseLower = base.toLowerCase();
  const isBareFillChild =
    baseLower === 'classic' ||
    baseLower === 'hybrid' ||
    baseLower === 'volume';
  if (!isBareFillChild) return base;

  if (!input.booking_time || !input.end_time) return base;
  const start = Date.parse(input.booking_time);
  const end = Date.parse(input.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return base;
  const mins = Math.round((end - start) / 60000);

  if (mins === 120) return `${base} 2 Week Fill`;
  if (mins === 150) return `${base} 3 Week Fill`;
  if (mins === 180) return `${base} 4 Week Fill`;
  return base;
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

/**
 * Format a digits-only phone number into a friendlier US-style
 * presentation:
 *   - 10 digits → "(555) 123-4567"
 *   - 11 digits starting with '1' → "+1 (555) 123-4567"
 *   - anything else → the raw digits unchanged (don't mangle
 *     international numbers we don't recognise).
 *
 * Returns the supplied fallback when the input is null/empty,
 * which keeps callers terse: `formatPhone(client.phone, '—')`.
 *
 * Lookup cache lives in module scope so the same number rendered
 * repeatedly (e.g. across hundreds of list rows on first paint)
 * only does the string-slice work once.
 */
const formatPhoneCache = new Map<string, string>();
/**
 * Whole-dollar CRM spend (e.g. lifetime value on directory cards).
 */
export function formatLifetimeSpend(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return '$0';
  if (Number.isInteger(dollars)) return `$${dollars.toLocaleString('en-US')}`;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const CANCELED_APPOINTMENT_STATUSES = new Set([
  'canceled_by_admin',
  'canceled_by_client',
  'canceled_by_client_late',
  'canceled_by_system',
  'cancelled',
]);

/**
 * Derive CRM stats from appointment rows (modal when opened from a
 * booking, or to refresh after history changes).
 */
export function computeCrmStatsFromAppointments(
  appointments: Array<{
    status: string | null;
    booking_time: string | null;
    service_price: number | null;
    stripe_customer_id: string | null;
  }>
): ClientCrmStats {
  const now = Date.now();
  let total_bookings = 0;
  let lifetime_value = 0;
  let has_vaulted_card = false;
  let risk_flag = false;

  for (const a of appointments) {
    const status = (a.status || '').toLowerCase();
    if (status === 'pending' || CANCELED_APPOINTMENT_STATUSES.has(status)) {
      if (status === 'no-show' || status === 'canceled_by_client_late') {
        risk_flag = true;
      }
      continue;
    }

    total_bookings += 1;

    if (status === 'no-show' || status === 'canceled_by_client_late') {
      risk_flag = true;
    }

    if (a.stripe_customer_id && a.stripe_customer_id.trim().length > 0) {
      has_vaulted_card = true;
    }

    const startMs = a.booking_time ? Date.parse(a.booking_time) : NaN;
    const isPast = Number.isFinite(startMs) && startMs < now;
    if (
      isPast &&
      (status === 'confirmed' || status === 'no-show') &&
      a.service_price != null &&
      Number.isFinite(a.service_price)
    ) {
      lifetime_value += a.service_price;
    }
  }

  return {
    total_bookings,
    lifetime_value,
    has_vaulted_card,
    risk_flag,
  };
}

export function formatPhone(
  digits: string | null,
  fallback = ''
): string {
  if (!digits) return fallback;
  const cached = formatPhoneCache.get(digits);
  if (cached) return cached;
  let out = digits;
  if (digits.length === 10) {
    out = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    out = `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  formatPhoneCache.set(digits, out);
  return out;
}
