/**
 * Client CRM identity helpers — phone is the canonical CRM key; email is required
 * for new bookings and client records.
 */

import {
  isPlaceholderClientEmail,
  isValidEmail,
  normalizeClientEmailForStorage,
} from './client-email.js';
import {
  clientPhoneLookupVariants as clientPhoneLookupVariantsImpl,
  normaliseClientPhoneForStorage as normaliseClientPhoneForStorageImpl,
  normaliseClientPhone as normaliseClientPhoneImpl,
  parseClientPhone as parseClientPhoneImpl,
  sqlPhoneVariants as sqlPhoneVariantsImpl,
} from './client-phone.js';

export {
  isPlaceholderClientEmail,
  isValidEmail,
  normalizeClientEmailForStorage,
};

export interface ParsedClientPhone {
  /** Digits only, usually 11 chars for US (+1 + 10-digit number). Used in Postgres. */
  digits: string;
  /** E.164 for Cal.com (`+18015551234`). */
  e164: string;
}

export const CLIENT_PHONE_HINT =
  'US mobile: 10 digits — we save it as +1 automatically for Cal.com (e.g. 801 555 1234).';

export function clientPhoneValidationMessage(): string {
  return 'Enter a valid US phone: 10 digits, or +1 followed by 10 digits (e.g. +18015551234).';
}

export function parseClientPhone(raw: unknown): ParsedClientPhone | null {
  return parseClientPhoneImpl(raw);
}

/** Digits-only phone normaliser for CRM lookups and storage (canonical US when possible). */
export function normaliseClientPhone(raw: unknown): string | null {
  return normaliseClientPhoneImpl(raw);
}

/**
 * Canonical US storage when possible; otherwise digits-only fallback for
 * international / legacy rows.
 */
export function normaliseClientPhoneForStorage(raw: unknown): string | null {
  return normaliseClientPhoneForStorageImpl(raw);
}

export function clientPhoneLookupVariants(digits: string): string[] {
  return clientPhoneLookupVariantsImpl(digits);
}

/** Up to two values for SQL OR / IN phone matching (10- vs 11-digit US). */
export function sqlPhoneVariants(phone: string): [string, string] {
  const pair = sqlPhoneVariantsImpl(phone) as [string, string];
  return [pair[0], pair[1] ?? pair[0]];
}

/** Pretty-print a stored digit string for admin inputs (US). */
export function formatPhoneInputDisplay(raw: string): string {
  const parsed = parseClientPhone(raw);
  if (!parsed) return raw.trim();

  const national =
    parsed.digits.length === 11 && parsed.digits.startsWith('1')
      ? parsed.digits.slice(1)
      : parsed.digits;

  if (national.length !== 10) return parsed.e164;

  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/** Trim + lowercase; empty / invalid / Cal placeholder → null. */
export function parseOptionalClientEmail(raw: unknown): string | null {
  return normalizeClientEmailForStorage(raw);
}

/** Same normalisation as optional parse; use when email must be present. */
export function parseRequiredClientEmail(raw: unknown): string | null {
  return normalizeClientEmailForStorage(raw);
}

export const REQUIRED_CLIENT_EMAIL_MESSAGE =
  'A valid email address is required.';

/**
 * Cal.com v2 requires `attendee.email`. When the admin omits email we send a
 * stable placeholder tied to the phone so bookings still succeed; our DB keeps
 * email NULL.
 */
export function calAttendeeEmailForBooking(
  phoneDigits: string,
  email: string | null
): string {
  if (email && isValidEmail(email)) return email;
  return `bookings+${phoneDigits}@placeholder.sadiemarie.co`;
}
