/**
 * Client CRM identity helpers — phone is the canonical key; email is optional.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits-only phone normaliser used across admin CRM routes. */
export function normaliseClientPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
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
  phone: string,
  email: string | null
): string {
  if (email) return email;
  return `bookings+${phone}@placeholder.sadiemarie.co`;
}
