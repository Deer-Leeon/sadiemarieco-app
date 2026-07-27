/**
 * Typed façade over lib/sms-templates.js for App Router / admin UI.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./sms-templates.js') as {
  STUDIO_SETTINGS_ROW_ID: 1;
  SMS_PREFIX: string;
  COMPLIANCE_TAIL: string;
  SMS_TEMPLATE_KEYS: readonly SmsTemplateKey[];
  SMS_TEMPLATE_META: Record<SmsTemplateKey, SmsTemplateMeta>;
  ALL_PLACEHOLDERS: readonly string[];
  SAMPLE_PREVIEW_VARS: Record<string, string>;
  extractPlaceholders: (body: string) => string[];
  validateSmsBody: (
    key: SmsTemplateKey,
    body: string
  ) => { ok: true; body: string } | { ok: false; error: string };
  renderSmsTemplate: (
    body: string,
    vars?: Record<string, string | null | undefined>
  ) => string;
  loadStoredTemplates: () => Promise<Partial<Record<SmsTemplateKey, string>>>;
  effectiveBody: (
    key: SmsTemplateKey,
    stored?: Partial<Record<SmsTemplateKey, string>>
  ) => string;
  resolveSmsCopy: (
    key: SmsTemplateKey,
    vars: Record<string, string | null | undefined>
  ) => Promise<string>;
  upsertSmsTemplate: (
    key: SmsTemplateKey,
    body: string | null
  ) => Promise<{ key: SmsTemplateKey; body: string; isCustom: boolean }>;
};

export type SmsTemplateKey =
  | 'confirmation'
  | 'reminder_48h'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'reschedule'
  | 'admin_cancel'
  | 'no_show_no_charge'
  | 'no_show_charged'
  | 'late_cancel_fee'
  | 'client_cancel_early'
  | 'client_cancel_late_no_fee'
  | 'client_cancel_after_start'
  | 'checkout_abandoned'
  | 'booking_pending'
  | 'phone_cancel'
  | 'feedback_day_after';

export interface SmsTemplateMeta {
  title: string;
  triggers: string[];
  allowedPlaceholders: string[];
  requiredPlaceholders: string[];
  defaultBody: string;
  /** False = draft in admin only; not wired to Twilio yet. */
  sendingLive: boolean;
}

/** Wire shape for one scenario card on GET /api/admin/sms-messages */
export interface SmsTemplateCardWire {
  key: SmsTemplateKey;
  title: string;
  triggers: string[];
  allowedPlaceholders: string[];
  requiredPlaceholders: string[];
  defaultBody: string;
  body: string;
  isCustom: boolean;
  sendingLive: boolean;
  prefix: string;
  footer: string;
  preview: string;
}

export const STUDIO_SETTINGS_ROW_ID = impl.STUDIO_SETTINGS_ROW_ID;
export const SMS_PREFIX = impl.SMS_PREFIX;
export const COMPLIANCE_TAIL = impl.COMPLIANCE_TAIL;
export const SMS_TEMPLATE_KEYS = impl.SMS_TEMPLATE_KEYS;
export const SMS_TEMPLATE_META = impl.SMS_TEMPLATE_META;
export const ALL_PLACEHOLDERS = impl.ALL_PLACEHOLDERS;
export const SAMPLE_PREVIEW_VARS = impl.SAMPLE_PREVIEW_VARS;
export const extractPlaceholders = impl.extractPlaceholders;
export const validateSmsBody = impl.validateSmsBody;
export const renderSmsTemplate = impl.renderSmsTemplate;
export const loadStoredTemplates = impl.loadStoredTemplates;
export const effectiveBody = impl.effectiveBody;
export const resolveSmsCopy = impl.resolveSmsCopy;
export const upsertSmsTemplate = impl.upsertSmsTemplate;

export async function listSmsTemplateCards(): Promise<SmsTemplateCardWire[]> {
  const stored = await loadStoredTemplates();
  return SMS_TEMPLATE_KEYS.map((key) => {
    const meta = SMS_TEMPLATE_META[key];
    const body = effectiveBody(key, stored);
    const isCustom =
      typeof stored[key] === 'string' &&
      stored[key]!.trim() !== '' &&
      stored[key]!.trim() !== meta.defaultBody;
    return {
      key,
      title: meta.title,
      triggers: meta.triggers,
      allowedPlaceholders: meta.allowedPlaceholders,
      requiredPlaceholders: meta.requiredPlaceholders,
      defaultBody: meta.defaultBody,
      body,
      isCustom,
      sendingLive: meta.sendingLive === true,
      prefix: SMS_PREFIX,
      footer: COMPLIANCE_TAIL,
      preview: renderSmsTemplate(body, SAMPLE_PREVIEW_VARS),
    };
  });
}
