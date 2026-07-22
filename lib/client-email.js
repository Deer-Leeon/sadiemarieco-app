/**
 * Client email validation — rejects Cal.com placeholder attendee addresses.
 * Shared by TypeScript routes (via client-identity.ts) and CommonJS handlers.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Domain used for synthetic Cal attendee emails when no real address is given.
 * Must have working MX records — Cal rejects domains that cannot receive mail
 * (`email_domain_cannot_receive_mail`). The studio domain qualifies; the old
 * `placeholder.sadiemarie.co` subdomain does not.
 */
const PLACEHOLDER_DOMAIN = 'sadiemarie.co';

/** Prior synthetic domain — still treat as placeholder if seen in old rows. */
const LEGACY_PLACEHOLDER_DOMAIN = 'placeholder.sadiemarie.co';

/**
 * True for Cal synthetic addresses (must never be stored in clients/appointments).
 */
function isPlaceholderClientEmail(email) {
  if (email === undefined || email === null) return true;
  if (typeof email !== 'string') return true;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return true;
  // Synthetic attendee: bookings+<phone>@sadiemarie.co (and legacy domain).
  if (normalized.startsWith('bookings+')) return true;
  if (normalized.endsWith(`@${LEGACY_PLACEHOLDER_DOMAIN}`)) return true;
  // Cal phone-only bookings: <digits>@sms.cal.com (also lands in checkout URL).
  if (normalized.endsWith('@sms.cal.com')) return true;
  return false;
}

/**
 * True when the value is a real, storable client email.
 */
function isValidEmail(email) {
  if (email === undefined || email === null) return false;
  if (typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return false;
  if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) return false;
  if (isPlaceholderClientEmail(trimmed)) return false;
  return true;
}

/**
 * Normalise for DB storage: trim, lowercase, or null when missing/invalid/placeholder.
 */
function normalizeClientEmailForStorage(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!isValidEmail(trimmed)) return null;
  return trimmed;
}

module.exports = {
  EMAIL_RE,
  PLACEHOLDER_DOMAIN,
  isPlaceholderClientEmail,
  isValidEmail,
  normalizeClientEmailForStorage,
};
