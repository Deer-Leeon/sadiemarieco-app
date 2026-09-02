/**
 * A2P-compliant transactional SMS copy for Sadie Marie.
 * Bodies are admin-editable via studio_settings.sms_templates
 * (see lib/sms-templates.js). Formatting helpers stay here for
 * callers that build placeholder vars.
 *
 * Prefer async resolve* helpers at send time so DB edits apply
 * immediately. Sync build* helpers render in-code defaults only
 * (no DB) for backwards-compatible call sites.
 */

const {
  resolveSmsCopy,
  renderSmsTemplate,
  SMS_TEMPLATE_META,
  COMPLIANCE_TAIL: SHARED_COMPLIANCE_TAIL,
} = require('./sms-templates.js');

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

const COMPLIANCE_TAIL = SHARED_COMPLIANCE_TAIL;

function confirmationVars({ serviceName, bookingTime, manageUrl }) {
  return {
    service: formatServiceTitle(serviceName),
    date: bookingTime ? formatStudioDate(bookingTime) : '',
    time: bookingTime ? formatStudioTime(bookingTime) : '',
    manageUrl: manageUrl || '',
  };
}

function reminder24hVars({ serviceName, bookingTime }) {
  return {
    service: formatServiceTitle(serviceName),
    date: bookingTime ? formatStudioDate(bookingTime) : '',
    time: bookingTime ? formatStudioTime(bookingTime) : '',
    arrivalHint: arrivalHint(serviceName),
  };
}

function reminder48hVars({ serviceName, bookingTime }) {
  return reminder24hVars({ serviceName, bookingTime });
}

function reminder1hVars({ serviceName }) {
  return {
    service: formatServiceTitle(serviceName),
    arrivalHint: arrivalHint(serviceName),
  };
}

function datedServiceVars({ serviceName, bookingTime }) {
  return {
    service: formatServiceTitle(serviceName),
    date: bookingTime ? formatStudioDate(bookingTime) : '',
    time: bookingTime ? formatStudioTime(bookingTime) : '',
  };
}

function noShowChargedVars({ serviceName, bookingTime, amountCents }) {
  return {
    ...datedServiceVars({ serviceName, bookingTime }),
    amount: formatUsdFromCents(amountCents) || 'a no-show fee',
  };
}

function rescheduleVars({ serviceName, bookingTime, manageUrl }) {
  return {
    service: formatServiceTitle(serviceName),
    date: bookingTime ? formatStudioDate(bookingTime) : '',
    time: bookingTime ? formatStudioTime(bookingTime) : '',
    manageUrl: manageUrl || '',
  };
}

function lateCancelVars({ serviceName, bookingTime, amountCents }) {
  return {
    ...datedServiceVars({ serviceName, bookingTime }),
    amount: formatUsdFromCents(amountCents) || '',
  };
}

/** Sync default-only builders (no DB). Prefer async resolve* at send time. */
function buildConfirmationSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.confirmation.defaultBody,
    confirmationVars(args)
  );
}

function buildReminder24hSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.reminder_24h.defaultBody,
    reminder24hVars(args)
  );
}

function buildReminder48hSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.reminder_48h.defaultBody,
    reminder48hVars(args)
  );
}

function buildReminder1hSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.reminder_1h.defaultBody,
    reminder1hVars(args)
  );
}

function buildAdminCancelSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.admin_cancel.defaultBody,
    datedServiceVars(args)
  );
}

function buildNoShowNoChargeSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.no_show_no_charge.defaultBody,
    datedServiceVars(args)
  );
}

function buildNoShowChargedSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.no_show_charged.defaultBody,
    noShowChargedVars(args)
  );
}

function buildRescheduleSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.reschedule.defaultBody,
    rescheduleVars(args)
  );
}

function buildLateCancelFeeSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.late_cancel_fee.defaultBody,
    lateCancelVars(args)
  );
}

function buildNoShowFreePassUsedSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.no_show_free_pass_used.defaultBody,
    datedServiceVars(args)
  );
}

function buildLateChangeFreePassUsedSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.late_change_free_pass_used.defaultBody,
    datedServiceVars(args)
  );
}

function buildNoShowFreePassGrantedSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.no_show_free_pass_granted.defaultBody,
    datedServiceVars(args)
  );
}

function buildLateChangeFreePassGrantedSms(args) {
  return renderSmsTemplate(
    SMS_TEMPLATE_META.late_change_free_pass_granted.defaultBody,
    datedServiceVars(args)
  );
}

async function resolveConfirmationSms(args) {
  return resolveSmsCopy('confirmation', confirmationVars(args));
}

async function resolveReminder24hSms(args) {
  return resolveSmsCopy('reminder_24h', reminder24hVars(args));
}

async function resolveReminder48hSms(args) {
  return resolveSmsCopy('reminder_48h', reminder48hVars(args));
}

async function resolveReminder1hSms(args) {
  return resolveSmsCopy('reminder_1h', reminder1hVars(args));
}

async function resolveAdminCancelSms(args) {
  return resolveSmsCopy('admin_cancel', datedServiceVars(args));
}

async function resolveNoShowNoChargeSms(args) {
  return resolveSmsCopy('no_show_no_charge', datedServiceVars(args));
}

async function resolveNoShowChargedSms(args) {
  return resolveSmsCopy('no_show_charged', noShowChargedVars(args));
}

async function resolveRescheduleSms(args) {
  return resolveSmsCopy('reschedule', rescheduleVars(args));
}

async function resolveLateCancelFeeSms(args) {
  return resolveSmsCopy('late_cancel_fee', lateCancelVars(args));
}

async function resolveNoShowFreePassUsedSms(args) {
  return resolveSmsCopy('no_show_free_pass_used', datedServiceVars(args));
}

async function resolveLateChangeFreePassUsedSms(args) {
  return resolveSmsCopy('late_change_free_pass_used', datedServiceVars(args));
}

async function resolveNoShowFreePassGrantedSms(args) {
  return resolveSmsCopy('no_show_free_pass_granted', datedServiceVars(args));
}

async function resolveLateChangeFreePassGrantedSms(args) {
  return resolveSmsCopy('late_change_free_pass_granted', datedServiceVars(args));
}

function siteUrlVar() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
    'https://www.sadiemarie.co'
  ).replace(/\/$/, '');
}

function cancelWithSiteVars({ serviceName, bookingTime }) {
  return {
    service: formatServiceTitle(serviceName),
    date: bookingTime ? formatStudioDate(bookingTime) : '',
    time: bookingTime ? formatStudioTime(bookingTime) : '',
    siteUrl: siteUrlVar(),
  };
}

function feedbackVars({ firstName, serviceName }) {
  return {
    firstName: firstName || '',
    service: formatServiceTitle(serviceName),
    siteUrl: siteUrlVar(),
  };
}

function resolveConsentRequestSms({ firstName, consentUrl }) {
  return resolveSmsCopy('consent_request', {
    firstName: firstName || '',
    consentUrl: consentUrl || '',
  });
}

async function resolveClientCancelEarlySms(args) {
  return resolveSmsCopy('client_cancel_early', cancelWithSiteVars(args));
}

async function resolveClientCancelLateNoFeeSms(args) {
  return resolveSmsCopy('client_cancel_late_no_fee', cancelWithSiteVars(args));
}

async function resolveCheckoutAbandonedSms(args) {
  return resolveSmsCopy('checkout_abandoned', cancelWithSiteVars(args));
}

async function resolveFeedbackDayAfterSms(args) {
  return resolveSmsCopy('feedback_day_after', feedbackVars(args));
}

const GOOGLE_REVIEW_URL = 'https://g.page/r/CQ0Tmk7shapREBM/review';

function reviewRequestVars({ firstName, serviceName }) {
  return {
    firstName: firstName || '',
    service: formatServiceTitle(serviceName),
    reviewUrl: GOOGLE_REVIEW_URL,
  };
}

async function resolveReviewRequestSms(args) {
  return resolveSmsCopy('review_request', reviewRequestVars(args));
}

function reviewRequestManualVars({ firstName }) {
  return {
    firstName: firstName || '',
    reviewUrl: GOOGLE_REVIEW_URL,
  };
}

async function resolveReviewRequestManualSms(args) {
  return resolveSmsCopy('review_request_manual', reviewRequestManualVars(args));
}

module.exports = {
  formatServiceTitle,
  formatStudioDate,
  formatStudioTime,
  formatUsdFromCents,
  arrivalHint,
  siteUrlVar,
  buildConfirmationSms,
  buildReminder24hSms,
  buildReminder48hSms,
  buildReminder1hSms,
  buildAdminCancelSms,
  buildNoShowNoChargeSms,
  buildNoShowChargedSms,
  buildRescheduleSms,
  buildLateCancelFeeSms,
  buildNoShowFreePassUsedSms,
  buildLateChangeFreePassUsedSms,
  buildNoShowFreePassGrantedSms,
  buildLateChangeFreePassGrantedSms,
  resolveConfirmationSms,
  resolveReminder24hSms,
  resolveReminder48hSms,
  resolveReminder1hSms,
  resolveAdminCancelSms,
  resolveNoShowNoChargeSms,
  resolveNoShowChargedSms,
  resolveRescheduleSms,
  resolveLateCancelFeeSms,
  resolveNoShowFreePassUsedSms,
  resolveLateChangeFreePassUsedSms,
  resolveNoShowFreePassGrantedSms,
  resolveLateChangeFreePassGrantedSms,
  resolveConsentRequestSms,
  resolveClientCancelEarlySms,
  resolveClientCancelLateNoFeeSms,
  resolveCheckoutAbandonedSms,
  resolveFeedbackDayAfterSms,
  resolveReviewRequestSms,
  resolveReviewRequestManualSms,
  GOOGLE_REVIEW_URL,
  COMPLIANCE_TAIL,
};
