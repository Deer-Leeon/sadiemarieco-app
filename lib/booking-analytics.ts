/**
 * Booking-funnel analytics (Vercel Web Analytics custom events).
 *
 * Never send PII (name, email, phone). Service labels are truncated to
 * Analytics' 255-char limit. Failures must never break booking.
 *
 * Event catalogue (see also public/js/booking-analytics.js):
 *   Booking Service Opened   — service drawer opened
 *   Booking Cal Step         — Cal embed navigated (calendar / time / details)
 *   Booking Details Submitted — Cal Confirm / phone book create
 *                               (`source`: phone_booker | phone_booker_apple_pay)
 *   Booking Contact Capture  — post-book contact panel shown
 *   Booking Hold Created     — /api/booking/init wrote pending row
 *   Checkout Viewed          — /checkout painted
 *   Checkout Payment Attempt — card or Apple Pay submit started
 *   Checkout Expired         — hold expired UI shown
 *   Booking Hold Abandoned   — pending → canceled_by_system
 *   Booking Confirmed        — /api/booking/confirm succeeded
 */

import { track } from '@vercel/analytics/server';

import { formatServiceTitleForDisplay } from '@/lib/format-booking-time';

export const BOOKING_ANALYTICS_EVENTS = {
  SERVICE_OPENED: 'Booking Service Opened',
  CAL_STEP: 'Booking Cal Step',
  DETAILS_SUBMITTED: 'Booking Details Submitted',
  CONTACT_CAPTURE: 'Booking Contact Capture',
  HOLD_CREATED: 'Booking Hold Created',
  CHECKOUT_VIEWED: 'Checkout Viewed',
  CHECKOUT_PAYMENT_ATTEMPT: 'Checkout Payment Attempt',
  CHECKOUT_EXPIRED: 'Checkout Expired',
  HOLD_ABANDONED: 'Booking Hold Abandoned',
  BOOKING_CONFIRMED: 'Booking Confirmed',
} as const;

export type BookingAnalyticsEvent =
  (typeof BOOKING_ANALYTICS_EVENTS)[keyof typeof BOOKING_ANALYTICS_EVENTS];

export type AnalyticsProps = Record<
  string,
  string | number | boolean | null | undefined
>;

/** Display-safe service label for event props (no PII, ≤255 chars). */
export function analyticsServiceLabel(
  raw: string | null | undefined
): string {
  const cleaned = formatServiceTitleForDisplay(raw) || 'Unknown';
  return cleaned.slice(0, 255);
}

function sanitizeProps(
  data?: AnalyticsProps
): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, 255);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Server-side track — safe to call from route handlers. */
export async function trackBookingEvent(
  name: BookingAnalyticsEvent | string,
  data?: AnalyticsProps
): Promise<void> {
  try {
    await track(name, sanitizeProps(data));
  } catch (err) {
    console.warn('[booking-analytics] track failed', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
