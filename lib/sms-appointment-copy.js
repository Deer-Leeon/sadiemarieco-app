/**
 * A2P-compliant transactional SMS copy for Sadie Marie.
 * Keep in sync with docs/a2p-sms-compliance.md sample messages.
 */

const STUDIO_TIMEZONE = 'America/Denver';

function formatServiceTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'appointment';
  const cleaned = raw.replace(/\s+between\s+.+$/i, '').trim();
  return cleaned || 'appointment';
}

function formatStudioDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: STUDIO_TIMEZONE,
  }).format(d);
}

function formatStudioTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: STUDIO_TIMEZONE,
  })
    .format(d)
    .replace(/\s?AM$/i, 'am')
    .replace(/\s?PM$/i, 'pm');
}

function formatUsdFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return '';
  const dollars = n / 100;
  return dollars % 1 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

function arrivalHint(serviceName) {
  const s = String(serviceName || '').toLowerCase();
  if (
    s.includes('lash') ||
    s.includes('full set') ||
    s.includes('fill') ||
    s.includes('hybrid') ||
    s.includes('volume') ||
    s.includes('classic')
  ) {
    return 'Please arrive with clean lashes and no eye makeup.';
  }
  if (s.includes('brow') || s.includes('lamination') || s.includes('tint')) {
    return 'Please arrive with clean brows and no makeup.';
  }
  return 'Please arrive a few minutes early.';
}

const COMPLIANCE_TAIL =
  'Msg & data rates may apply. Reply STOP to opt out, HELP for help.';

function whenPhrase(bookingTime) {
  const date = bookingTime ? formatStudioDate(bookingTime) : '';
  const time = bookingTime ? formatStudioTime(bookingTime) : '';
  if (date && time) return ` on ${date} at ${time}`;
  if (date) return ` on ${date}`;
  return '';
}

/**
 * Confirmation — sent after successful checkout (card vaulted).
 */
function buildConfirmationSms({
  serviceName,
  bookingTime,
  manageUrl,
}) {
  const service = formatServiceTitle(serviceName);
  const date = bookingTime ? formatStudioDate(bookingTime) : '';
  const time = bookingTime ? formatStudioTime(bookingTime) : '';
  const when =
    date && time ? ` for ${date} at ${time}` : date ? ` for ${date}` : '';
  return `Sadie Marie: Your ${service} is confirmed${when}. Manage, reschedule, or cancel: ${manageUrl}. Msg frequency varies. ${COMPLIANCE_TAIL}`;
}

/**
 * ~24h reminder SMS.
 */
function buildReminder24hSms({ serviceName, bookingTime }) {
  const service = formatServiceTitle(serviceName);
  const time = bookingTime ? formatStudioTime(bookingTime) : '';
  const timeBit = time ? ` at ${time}` : '';
  const hint = arrivalHint(serviceName);
  return `Sadie Marie: Reminder — your ${service} is tomorrow${timeBit}. ${hint} ${COMPLIANCE_TAIL}`;
}

/**
 * ~1h reminder SMS.
 */
function buildReminder1hSms({ serviceName }) {
  const service = formatServiceTitle(serviceName);
  const hint = arrivalHint(serviceName);
  return `Sadie Marie: Your ${service} is in one hour. ${hint} ${COMPLIANCE_TAIL}`;
}

/**
 * Admin canceled the appointment from the dashboard.
 */
function buildAdminCancelSms({ serviceName, bookingTime }) {
  const service = formatServiceTitle(serviceName);
  return `Sadie Marie: Your ${service}${whenPhrase(bookingTime)} has been canceled. ${COMPLIANCE_TAIL}`;
}

/**
 * Admin marked no-show without charging a fee (strike only).
 */
function buildNoShowNoChargeSms({ serviceName, bookingTime }) {
  const service = formatServiceTitle(serviceName);
  return `Sadie Marie: You were marked as a no-show for your ${service}${whenPhrase(bookingTime)}. Please reach out if you'd like to rebook. ${COMPLIANCE_TAIL}`;
}

/**
 * Admin marked no-show and charged the 50% fee.
 * @param {number} amountCents
 */
function buildNoShowChargedSms({ serviceName, bookingTime, amountCents }) {
  const service = formatServiceTitle(serviceName);
  const amount = formatUsdFromCents(amountCents) || 'a no-show fee';
  return `Sadie Marie: You were marked as a no-show for your ${service}${whenPhrase(bookingTime)}. A no-show fee of ${amount} was charged to your card on file. ${COMPLIANCE_TAIL}`;
}

/**
 * Appointment rescheduled (admin or client) — includes manage link for the new UID.
 */
function buildRescheduleSms({
  serviceName,
  bookingTime,
  manageUrl,
}) {
  const service = formatServiceTitle(serviceName);
  const date = bookingTime ? formatStudioDate(bookingTime) : '';
  const time = bookingTime ? formatStudioTime(bookingTime) : '';
  const when =
    date && time ? ` to ${date} at ${time}` : date ? ` to ${date}` : '';
  return `Sadie Marie: Your ${service} has been rescheduled${when}. Manage, reschedule, or cancel: ${manageUrl}. Msg frequency varies. ${COMPLIANCE_TAIL}`;
}

/**
 * Client canceled within 24h and the $20 late fee was charged successfully.
 */
function buildLateCancelFeeSms({ serviceName, bookingTime, amountCents }) {
  const service = formatServiceTitle(serviceName);
  const amount = formatUsdFromCents(amountCents) || '$20';
  return `Sadie Marie: Your ${service}${whenPhrase(bookingTime)} was canceled. A late-cancel fee of ${amount} was charged to your card on file. ${COMPLIANCE_TAIL}`;
}

module.exports = {
  formatServiceTitle,
  formatStudioDate,
  formatStudioTime,
  formatUsdFromCents,
  arrivalHint,
  buildConfirmationSms,
  buildReminder24hSms,
  buildReminder1hSms,
  buildAdminCancelSms,
  buildNoShowNoChargeSms,
  buildNoShowChargedSms,
  buildRescheduleSms,
  buildLateCancelFeeSms,
  COMPLIANCE_TAIL,
};
