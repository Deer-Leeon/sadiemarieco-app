/**
 * Shared Cal.com embed constants and event parsing for admin + public flows.
 */

/** Must match `app/route.ts` and `AppointmentModal.tsx`. */
export const CAL_USERNAME = 'mckenna-sadiemarie';

/** Compact booker for the admin manual-booking modal (calendar + slots in one row). */
export const MANUAL_BOOKING_CAL_UI_CONFIG = {
  theme: 'light' as const,
  styles: { branding: { brandColor: '#292524' } },
  hideEventTypeDetails: true,
  layout: 'column_view' as const,
  disableAutoScroll: false,
  cssVarsPerTheme: {
    light: {
      'cal-brand': '#1c1917',
      'cal-brand-emphasis': '#292524',
      'cal-brand-text': '#FAF9F6',
      'cal-brand-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-brand-accent': '#44403c',
      'cal-bg': 'transparent',
      'cal-bg-emphasis': 'rgba(28, 25, 23, 0.08)',
      'cal-bg-muted': 'rgba(28, 25, 23, 0.04)',
      'cal-bg-subtle': 'rgba(28, 25, 23, 0.03)',
      'cal-bg-inverted': '#1c1917',
      'cal-bg-info': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-success': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-attention': 'rgba(180, 83, 9, 0.08)',
      'cal-bg-error': 'rgba(159, 18, 57, 0.08)',
      'cal-bg-dark-error': 'rgba(159, 18, 57, 0.18)',
      'cal-border': 'rgba(28, 25, 23, 0.16)',
      'cal-border-emphasis': 'rgba(28, 25, 23, 0.42)',
      'cal-border-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-border-booker': 'transparent',
      'cal-border-error': 'rgba(159, 18, 57, 0.32)',
      'cal-text': '#1c1917',
      'cal-text-emphasis': '#0c0a09',
      'cal-text-subtle': '#57534e',
      'cal-text-muted': '#78716c',
      'cal-text-inverted': '#FAF9F6',
      'cal-text-error': '#9f1239',
    },
    dark: {
      'cal-brand': '#1c1917',
      'cal-brand-emphasis': '#292524',
      'cal-brand-text': '#FAF9F6',
      'cal-brand-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-brand-accent': '#44403c',
      'cal-bg': 'transparent',
      'cal-bg-emphasis': 'rgba(28, 25, 23, 0.08)',
      'cal-bg-muted': 'rgba(28, 25, 23, 0.04)',
      'cal-bg-subtle': 'rgba(28, 25, 23, 0.03)',
      'cal-bg-inverted': '#1c1917',
      'cal-bg-info': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-success': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-attention': 'rgba(180, 83, 9, 0.08)',
      'cal-bg-error': 'rgba(159, 18, 57, 0.08)',
      'cal-bg-dark-error': 'rgba(159, 18, 57, 0.18)',
      'cal-border': 'rgba(28, 25, 23, 0.16)',
      'cal-border-emphasis': 'rgba(28, 25, 23, 0.42)',
      'cal-border-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-border-booker': 'transparent',
      'cal-border-error': 'rgba(159, 18, 57, 0.32)',
      'cal-text': '#1c1917',
      'cal-text-emphasis': '#0c0a09',
      'cal-text-subtle': '#57534e',
      'cal-text-muted': '#78716c',
      'cal-text-inverted': '#FAF9F6',
      'cal-text-error': '#9f1239',
    },
  },
};

export const ADMIN_CAL_UI_CONFIG = {
  theme: 'light' as const,
  styles: { branding: { brandColor: '#292524' } },
  hideEventTypeDetails: false,
  layout: 'month_view' as const,
  cssVarsPerTheme: {
    light: {
      'cal-brand': '#1c1917',
      'cal-brand-emphasis': '#292524',
      'cal-brand-text': '#FAF9F6',
      'cal-brand-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-brand-accent': '#44403c',
      'cal-bg': 'transparent',
      'cal-bg-emphasis': 'rgba(28, 25, 23, 0.08)',
      'cal-bg-muted': 'rgba(28, 25, 23, 0.04)',
      'cal-bg-subtle': 'rgba(28, 25, 23, 0.03)',
      'cal-bg-inverted': '#1c1917',
      'cal-bg-info': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-success': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-attention': 'rgba(180, 83, 9, 0.08)',
      'cal-bg-error': 'rgba(159, 18, 57, 0.08)',
      'cal-bg-dark-error': 'rgba(159, 18, 57, 0.18)',
      'cal-border': 'rgba(28, 25, 23, 0.16)',
      'cal-border-emphasis': 'rgba(28, 25, 23, 0.42)',
      'cal-border-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-border-booker': 'transparent',
      'cal-border-error': 'rgba(159, 18, 57, 0.32)',
      'cal-text': '#1c1917',
      'cal-text-emphasis': '#0c0a09',
      'cal-text-subtle': '#57534e',
      'cal-text-muted': '#78716c',
      'cal-text-inverted': '#FAF9F6',
      'cal-text-error': '#9f1239',
    },
    dark: {
      'cal-brand': '#1c1917',
      'cal-brand-emphasis': '#292524',
      'cal-brand-text': '#FAF9F6',
      'cal-brand-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-brand-accent': '#44403c',
      'cal-bg': 'transparent',
      'cal-bg-emphasis': 'rgba(28, 25, 23, 0.08)',
      'cal-bg-muted': 'rgba(28, 25, 23, 0.04)',
      'cal-bg-subtle': 'rgba(28, 25, 23, 0.03)',
      'cal-bg-inverted': '#1c1917',
      'cal-bg-info': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-success': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-attention': 'rgba(180, 83, 9, 0.08)',
      'cal-bg-error': 'rgba(159, 18, 57, 0.08)',
      'cal-bg-dark-error': 'rgba(159, 18, 57, 0.18)',
      'cal-border': 'rgba(28, 25, 23, 0.16)',
      'cal-border-emphasis': 'rgba(28, 25, 23, 0.42)',
      'cal-border-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-border-booker': 'transparent',
      'cal-border-error': 'rgba(159, 18, 57, 0.32)',
      'cal-text': '#1c1917',
      'cal-text-emphasis': '#0c0a09',
      'cal-text-subtle': '#57534e',
      'cal-text-muted': '#78716c',
      'cal-text-inverted': '#FAF9F6',
      'cal-text-error': '#9f1239',
    },
  },
};

export interface ExtractedBookingData {
  uid: string | null;
  startTime: string | null;
  endTime: string | null;
}

/** Prefill phone when the event type uses "Attendee Phone" as a location. */
export function calEmbedPhoneLocation(phone: string): string {
  return JSON.stringify({
    value: 'phone',
    optionValue: phone,
  });
}

export function extractBookingDataFromEvent(event: unknown): ExtractedBookingData {
  const fallback: ExtractedBookingData = {
    uid: null,
    startTime: null,
    endTime: null,
  };
  if (!event || typeof event !== 'object') return fallback;
  const detail = (event as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return fallback;
  const data = (detail as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return fallback;

  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const flat = data as Record<string, unknown>;
  const directUid = asString(flat.uid);
  const directStart = asString(flat.startTime) ?? asString(flat.start);
  const directEnd = asString(flat.endTime) ?? asString(flat.end);

  if (directUid || directStart || directEnd) {
    return {
      uid: directUid,
      startTime: directStart,
      endTime: directEnd,
    };
  }

  const booking = flat.booking;
  if (booking && typeof booking === 'object') {
    const b = booking as Record<string, unknown>;
    return {
      uid: asString(b.uid),
      startTime: asString(b.startTime) ?? asString(b.start),
      endTime: asString(b.endTime) ?? asString(b.end),
    };
  }

  return fallback;
}
