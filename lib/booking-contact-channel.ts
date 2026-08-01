/**
 * Public bookings need a reachable contact channel:
 * a real email address OR explicit SMS opt-in (never phone alone).
 *
 * SMS consent stays optional for A2P — email alone still completes a booking.
 */

import {
  isValidEmail,
  normalizeClientEmailForStorage,
} from '@/lib/client-identity';

/** Cancel reason for incomplete contact — webhook treats as system (no late fee). */
export const CONTACT_CHANNEL_CANCEL_REASON =
  'Incomplete booking: email or SMS opt-in required.';

export const CONTACT_CHANNEL_REQUIRED_MESSAGE =
  'Please add an email address or check the box to receive appointment texts so we can reach you about your booking.';

export function isContactChannelCancelReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  return reason.trim() === CONTACT_CHANNEL_CANCEL_REASON;
}

/** Parse Cal `sms-consent` from booking field response bags. */
export function parseSmsOptInFromSources(
  ...sources: Array<Record<string, unknown> | null | undefined>
): boolean | undefined {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const raw =
      src['sms-consent'] ?? src.smsConsent ?? src.sms_consent ?? null;
    if (raw == null) continue;
    const value =
      typeof raw === 'object' && raw !== null && 'value' in raw
        ? (raw as { value: unknown }).value
        : raw;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
    }
  }
  return undefined;
}

export function hasRealBookingEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const normalized = normalizeClientEmailForStorage(email);
  return Boolean(normalized && isValidEmail(normalized));
}

export function hasBookingContactChannel(args: {
  email?: unknown;
  smsOptIn?: boolean | undefined;
}): boolean {
  return hasRealBookingEmail(args.email) || args.smsOptIn === true;
}
