/**
 * Studio-local appointment date/time labels for emails + checkout.
 */

import { STUDIO_TIMEZONE } from '@/lib/cal-config';

export function formatBookingStartParts(iso: string): {
  date: string;
  time: string;
  combined: string;
} {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { date: iso, time: '', combined: iso };
  }

  const datePart = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: STUDIO_TIMEZONE,
  }).format(date);

  const timePart = formatStudioTime(date);

  return {
    date: datePart,
    time: timePart,
    combined: `${datePart} at ${timePart}`,
  };
}

export function formatStudioTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: STUDIO_TIMEZONE,
  })
    .format(date)
    .replace(/\s?AM$/i, 'am')
    .replace(/\s?PM$/i, 'pm');
}

/** "Saturday, July 25" + "10:00am – 1:00pm" for checkout. */
export function formatAppointmentWhen(
  bookingTimeIso: string,
  endTimeIso?: string | null
): { date: string; timeRange: string } | null {
  const start = new Date(bookingTimeIso);
  if (Number.isNaN(start.getTime())) return null;

  const { date, time: startTime } = formatBookingStartParts(bookingTimeIso);
  const end = endTimeIso ? new Date(endTimeIso) : null;
  const endTime =
    end && !Number.isNaN(end.getTime()) ? formatStudioTime(end) : null;

  return {
    date,
    timeRange: endTime ? `${startTime} – ${endTime}` : startTime,
  };
}

/** Cal titles often append " between Host and Guest" — drop for display. */
export function formatServiceTitleForDisplay(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+between\s+.+$/i, '').trim();
}
