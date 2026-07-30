/**
 * Admin-editable SMS templates for transactional appointment texts.
 * Bodies are stored on studio_settings.sms_templates; locked A2P chrome
 * (brand prefix + STOP/HELP footer) is always applied at render time.
 *
 * CommonJS so booking-notifications.js / remind.js can require() it.
 */

const { sql } = require('@vercel/postgres');

const STUDIO_SETTINGS_ROW_ID = 1;

const SMS_PREFIX = 'Sadie Marie: ';
const COMPLIANCE_TAIL =
  'Msg & data rates may apply. Reply STOP to opt out, HELP for help.';

/** @typedef {'confirmation'|'reminder_48h'|'reminder_24h'|'reminder_1h'|'reschedule'|'admin_cancel'|'no_show_no_charge'|'no_show_charged'|'late_cancel_fee'|'no_show_free_pass_used'|'late_change_free_pass_used'|'no_show_free_pass_granted'|'late_change_free_pass_granted'|'consent_request'|'client_cancel_early'|'client_cancel_late_no_fee'|'checkout_abandoned'|'feedback_day_after'} SmsTemplateKey */

/** @type {readonly SmsTemplateKey[]} */
const SMS_TEMPLATE_KEYS = Object.freeze([
  // Live — wired to Twilio today
  'confirmation',
  'reminder_48h',
  'reminder_24h',
  'reminder_1h',
  'reschedule',
  'admin_cancel',
  'no_show_no_charge',
  'no_show_charged',
  'late_cancel_fee',
  'no_show_free_pass_used',
  'late_change_free_pass_used',
  'no_show_free_pass_granted',
  'late_change_free_pass_granted',
  'consent_request',
  // Draft placeholders — editable in admin, not sent until send logic is wired
  'client_cancel_early',
  'client_cancel_late_no_fee',
  'checkout_abandoned',
  'feedback_day_after',
]);

const ALL_PLACEHOLDERS = Object.freeze([
  'service',
  'date',
  'time',
  'manageUrl',
  'amount',
  'arrivalHint',
  'siteUrl',
  'firstName',
  'consentUrl',
]);

/**
 * @type {Record<SmsTemplateKey, {
 *   title: string,
 *   triggers: string[],
 *   allowedPlaceholders: string[],
 *   requiredPlaceholders: string[],
 *   defaultBody: string,
 *   sendingLive: boolean,
 * }>}
 */
const SMS_TEMPLATE_META = Object.freeze({
  confirmation: {
    title: 'Booking confirmation',
    triggers: [
      'Client finishes Stripe checkout on /checkout after booking on the public site.',
      'Admin completes a manual booking in the admin dashboard.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'manageUrl'],
    requiredPlaceholders: ['manageUrl'],
    defaultBody:
      'Your {{service}} is confirmed for {{date}} at {{time}}. Manage, reschedule, or cancel: {{manageUrl}}. Msg frequency varies.',
    sendingLive: true,
  },
  reminder_48h: {
    title: '48-hour reminder (Brow Services)',
    triggers: [
      'System sends via QStash about 48 hours before a confirmed Brow Services (or Teeth Whitening) appointment.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'arrivalHint'],
    requiredPlaceholders: [],
    defaultBody:
      'Reminder — your {{service}} is in two days at {{time}}. {{arrivalHint}}',
    sendingLive: true,
  },
  reminder_24h: {
    title: '24-hour reminder (Lash Services)',
    triggers: [
      'System sends via QStash about 24 hours before a confirmed Lash Services appointment.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'arrivalHint'],
    requiredPlaceholders: [],
    defaultBody:
      'Reminder — your {{service}} is tomorrow at {{time}}. {{arrivalHint}}',
    sendingLive: true,
  },
  reminder_1h: {
    title: '1-hour reminder',
    triggers: [
      'System sends via QStash about 1 hour before a confirmed appointment (POST /api/remind).',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'arrivalHint'],
    requiredPlaceholders: [],
    defaultBody: 'Your {{service}} is in one hour. {{arrivalHint}}',
    sendingLive: true,
  },
  reschedule: {
    title: 'Reschedule confirmation',
    triggers: [
      'Client reschedules via Cal.com or the /manage portal.',
      'Admin reschedules an appointment in the admin dashboard.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'manageUrl'],
    requiredPlaceholders: ['manageUrl'],
    defaultBody:
      'Your {{service}} has been rescheduled to {{date}} at {{time}}. Manage, reschedule, or cancel: {{manageUrl}}. Msg frequency varies.',
    sendingLive: true,
  },
  admin_cancel: {
    title: 'Admin cancellation',
    triggers: [
      'Admin marks an appointment as canceled by admin in the appointment detail sheet.',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      'Your {{service}} on {{date}} at {{time}} has been canceled.',
    sendingLive: true,
  },
  no_show_no_charge: {
    title: 'No-show (no fee)',
    triggers: [
      'Admin marks a no-show without charging a fee (reactivates attention flag).',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      'You were marked as a no-show for your {{service}} on {{date}} at {{time}}. Please reach out if you\'d like to rebook.',
    sendingLive: true,
  },
  no_show_charged: {
    title: 'No-show (fee charged)',
    triggers: [
      'Admin marks a no-show and the full (100%) no-show fee charge succeeds.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'amount'],
    requiredPlaceholders: ['amount'],
    defaultBody:
      'You were marked as a no-show for your {{service}} on {{date}} at {{time}}. A no-show fee of {{amount}} was charged to your card on file.',
    sendingLive: true,
  },
  late_cancel_fee: {
    title: 'Late-cancel / late-reschedule fee receipt',
    triggers: [
      'Client cancels or reschedules 2–24 hours before start and the 50% late-change fee charge succeeds (Cal webhook). Under-2h changes use the no_show_charged template instead.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'amount'],
    requiredPlaceholders: ['amount'],
    defaultBody:
      'Your {{service}} on {{date}} at {{time}} was canceled or rescheduled. A late-change fee of {{amount}} was charged to your card on file.',
    sendingLive: true,
  },
  no_show_free_pass_used: {
    title: 'No-show free pass used',
    triggers: [
      'A no-show fee is waived because the client still had a one-time free pass (auto under-2h cancel/reschedule, or admin No charge while the pass was active).',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      'You were marked as a no-show for your {{service}} on {{date}} at {{time}}. This fee was waived as a one-time courtesy — future no-shows will be charged to your card on file.',
    sendingLive: true,
  },
  late_change_free_pass_used: {
    title: 'Late-change free pass used',
    triggers: [
      'A 2h–24h late-change fee is waived because the client still had a one-time late-change free pass (cancel or reschedule).',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      'Your {{service}} on {{date}} at {{time}} was canceled or rescheduled within our late-change window. The late-change fee was waived as a one-time courtesy — future late changes will be charged to your card on file.',
    sendingLive: true,
  },
  no_show_free_pass_granted: {
    title: 'No-show free pass granted',
    triggers: [
      'Admin grants another one-time no-show fee waiver on the client profile.',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      "We've applied a one-time no-show fee waiver to your account. Your next no-show will not be charged; after that, the full no-show fee applies.",
    sendingLive: true,
  },
  late_change_free_pass_granted: {
    title: 'Late-change free pass granted',
    triggers: [
      'Admin grants another one-time late-change fee waiver on the client profile.',
    ],
    allowedPlaceholders: ['service', 'date', 'time'],
    requiredPlaceholders: [],
    defaultBody:
      "We've applied a one-time late-change fee waiver to your account. Your next late cancel or reschedule will not be charged; after that, the late-change fee applies.",
    sendingLive: true,
  },

  consent_request: {
    title: 'Consent / intake form request',
    triggers: [
      'After a booking is confirmed (checkout or admin manual booking), if this phone/client has not signed consent yet.',
      'Separate message from the booking confirmation — only when SMS opt-in is true.',
    ],
    allowedPlaceholders: ['firstName', 'consentUrl'],
    requiredPlaceholders: ['consentUrl'],
    defaultBody:
      'Hi {{firstName}} — please complete your intake & consent form before your visit: {{consentUrl}}',
    sendingLive: true,
  },

  // ── Draft placeholders (not wired to send yet) ─────────────────────────

  client_cancel_early: {
    title: 'Client cancel (on time)',
    triggers: [
      'Client cancels more than 24 hours before the appointment via /manage or Cal.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'siteUrl'],
    requiredPlaceholders: [],
    defaultBody:
      'Your {{service}} on {{date}} at {{time}} has been canceled. We hope to see you again soon — book anytime at {{siteUrl}}.',
    sendingLive: false,
  },
  client_cancel_late_no_fee: {
    title: 'Client late cancel (no fee charged)',
    triggers: [
      'Client cancels within 24 hours, but no late-cancel fee is charged (no card on file or charge failed).',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'siteUrl'],
    requiredPlaceholders: [],
    defaultBody:
      'Your {{service}} on {{date}} at {{time}} was canceled. No fee was charged this time. When you\'re ready, you can rebook at {{siteUrl}}.',
    sendingLive: false,
  },
  checkout_abandoned: {
    title: 'Abandoned checkout',
    triggers: [
      'Client reserved a time but never finished card checkout; the hold is released.',
    ],
    allowedPlaceholders: ['service', 'date', 'time', 'siteUrl'],
    requiredPlaceholders: [],
    defaultBody:
      'Your hold for {{service}} on {{date}} at {{time}} was released because checkout wasn\'t completed. Book again anytime at {{siteUrl}}.',
    sendingLive: false,
  },
  feedback_day_after: {
    title: 'Day-after thank-you',
    triggers: [
      'System follow-up the day after a completed visit (not scheduled today — draft only until wired).',
    ],
    allowedPlaceholders: ['firstName', 'service', 'siteUrl'],
    requiredPlaceholders: [],
    defaultBody:
      'Hi {{firstName}}! Thank you for visiting Sadie Marie. We loved having you in for your {{service}}. Book your next visit anytime: {{siteUrl}}.',
    sendingLive: false,
  },
});

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * @param {string} body
 * @returns {string[]}
 */
function extractPlaceholders(body) {
  const found = new Set();
  const text = typeof body === 'string' ? body : '';
  let match;
  const re = new RegExp(TOKEN_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * @param {SmsTemplateKey} key
 * @param {string} body
 * @returns {{ ok: true, body: string } | { ok: false, error: string }}
 */
function validateSmsBody(key, body) {
  if (!SMS_TEMPLATE_KEYS.includes(key)) {
    return { ok: false, error: `Unknown template key "${key}".` };
  }
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Message body cannot be empty.' };
  }
  const meta = SMS_TEMPLATE_META[key];
  const used = extractPlaceholders(trimmed);
  const allowed = new Set(meta.allowedPlaceholders);
  const disallowed = used.filter((t) => !allowed.has(t));
  if (disallowed.length > 0) {
    return {
      ok: false,
      error: `This message cannot use: ${disallowed.map((t) => `{{${t}}}`).join(', ')}.`,
    };
  }
  for (const req of meta.requiredPlaceholders) {
    if (!used.includes(req)) {
      return {
        ok: false,
        error: `This message must include {{${req}}}.`,
      };
    }
  }
  return { ok: true, body: trimmed };
}

/**
 * @param {string} body
 * @param {Record<string, string | null | undefined>} vars
 * @returns {string}
 */
function renderSmsTemplate(body, vars = {}) {
  let out = typeof body === 'string' ? body : '';
  for (const key of ALL_PLACEHOLDERS) {
    const value = vars[key];
    const replacement =
      value == null || value === undefined ? '' : String(value);
    out = out.split(`{{${key}}}`).join(replacement);
  }
  // Strip any leftover unknown tokens defensively.
  out = out.replace(TOKEN_RE, '');
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\s+,/g, ',')
    .trim();
  return `${SMS_PREFIX}${out} ${COMPLIANCE_TAIL}`.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * @returns {Promise<Record<string, string>>}
 */
async function loadStoredTemplates() {
  try {
    const { rows } = await sql`
      SELECT sms_templates
      FROM studio_settings
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
    `;
    const raw = rows[0]?.sms_templates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of SMS_TEMPLATE_KEYS) {
      const val = raw[key];
      if (typeof val === 'string' && val.trim()) {
        out[key] = val.trim();
      }
    }
    return out;
  } catch (err) {
    console.warn('[sms-templates] failed to load studio_settings.sms_templates', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Effective body for a key (DB override or default).
 * @param {SmsTemplateKey} key
 * @param {Record<string, string>} [stored]
 */
function effectiveBody(key, stored = {}) {
  const override = stored[key];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return SMS_TEMPLATE_META[key].defaultBody;
}

/**
 * Resolve final outbound SMS text at send time (no cache).
 * @param {SmsTemplateKey} key
 * @param {Record<string, string | null | undefined>} vars
 */
async function resolveSmsCopy(key, vars) {
  const stored = await loadStoredTemplates();
  const body = effectiveBody(key, stored);
  return renderSmsTemplate(body, vars);
}

/**
 * Merge one template body into studio_settings.sms_templates.
 * Pass null/empty body to clear the override (revert to default).
 * @param {SmsTemplateKey} key
 * @param {string | null} body
 */
async function upsertSmsTemplate(key, body) {
  if (!SMS_TEMPLATE_KEYS.includes(key)) {
    throw new Error(`Unknown template key "${key}".`);
  }

  const clear = body == null || String(body).trim() === '';
  let nextBody = null;
  if (!clear) {
    const validated = validateSmsBody(key, body);
    if (!validated.ok) {
      const err = new Error(validated.error);
      err.code = 'validation';
      throw err;
    }
    nextBody = validated.body;
  }

  // Ensure singleton row exists.
  await sql`
    INSERT INTO studio_settings (id, sms_templates)
    VALUES (${STUDIO_SETTINGS_ROW_ID}, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;

  const { rows } = await sql`
    SELECT sms_templates
    FROM studio_settings
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
  `;
  const raw = rows[0]?.sms_templates;
  /** @type {Record<string, string>} */
  const current =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw }
      : {};

  if (clear) {
    delete current[key];
  } else {
    current[key] = nextBody;
  }

  const serialized = JSON.stringify(current);
  await sql`
    UPDATE studio_settings
    SET
      sms_templates = ${serialized}::jsonb,
      updated_at = NOW()
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
  `;

  const stored = await loadStoredTemplates();
  return {
    key,
    body: effectiveBody(key, stored),
    isCustom:
      typeof stored[key] === 'string' &&
      stored[key].trim() !== '' &&
      stored[key].trim() !== SMS_TEMPLATE_META[key].defaultBody,
  };
}

/**
 * Sample vars for admin live preview.
 */
const SAMPLE_PREVIEW_VARS = Object.freeze({
  service: 'Classic Full Set',
  date: 'Monday, July 27',
  time: '3:00 pm',
  manageUrl: 'https://sadiemarie.co/manage.html?uid=sample',
  amount: '$20',
  arrivalHint: 'Please arrive with clean lashes and no eye makeup.',
  siteUrl: 'https://sadiemarie.co',
  firstName: 'Alex',
  consentUrl: 'https://sadiemarie.co/consent/00000000-0000-0000-0000-000000000001',
});

module.exports = {
  STUDIO_SETTINGS_ROW_ID,
  SMS_PREFIX,
  COMPLIANCE_TAIL,
  SMS_TEMPLATE_KEYS,
  SMS_TEMPLATE_META,
  ALL_PLACEHOLDERS,
  SAMPLE_PREVIEW_VARS,
  extractPlaceholders,
  validateSmsBody,
  renderSmsTemplate,
  loadStoredTemplates,
  effectiveBody,
  resolveSmsCopy,
  upsertSmsTemplate,
};
