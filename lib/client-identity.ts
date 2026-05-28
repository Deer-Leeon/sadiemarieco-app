/**
 * Client CRM identity helpers — phone is the canonical key; email is optional.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

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

/**
 * Parse and normalise phone for CRM storage (digits) and Cal.com (E.164).
 * Studio default: US (+1) when the number is 10 or 11 digits without a leading +.
 */
export function parseClientPhone(raw: unknown): ParsedClientPhone | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    const e164 = `+${digits}`;
    if (!E164_RE.test(e164)) return null;
    return { digits, e164 };
  }

  if (digits.length === 10) {
    return { digits: `1${digits}`, e164: `+1${digits}` };
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return { digits, e164: `+${digits}` };
  }

  return null;
}

/** Digits-only phone normaliser for CRM lookups and storage. */
export function normaliseClientPhone(raw: unknown): string | null {
  return parseClientPhone(raw)?.digits ?? null;
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

/** Trim + lowercase; empty string → null. Invalid format → null. */
export function parseOptionalClientEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) return null;
  return trimmed;
}

/**
 * Cal.com v2 requires `attendee.email`. When the admin omits email we send a
 * stable placeholder tied to the phone so bookings still succeed; our DB keeps
 * email NULL.
 */
export function calAttendeeEmailForBooking(
  phoneDigits: string,
  email: string | null
): string {
  if (email) return email;
  return `bookings+${phoneDigits}@placeholder.sadiemarie.co`;
}
