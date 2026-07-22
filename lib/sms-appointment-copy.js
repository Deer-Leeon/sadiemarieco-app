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

module.exports = {
  formatServiceTitle,
  formatStudioDate,
  formatStudioTime,
  arrivalHint,
  buildConfirmationSms,
  buildReminder24hSms,
  buildReminder1hSms,
  COMPLIANCE_TAIL,
};
