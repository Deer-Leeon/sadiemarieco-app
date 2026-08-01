/**
 * Admin-editable email body paragraphs (confirmation / reminder / consent).
 * Layout chrome stays locked in lib/email-templates.ts — only the middle
 * copy is stored in studio_settings.email_templates.
 */

import { sql } from '@vercel/postgres';

import type { ReminderEmailTiming } from '@/lib/appointment-reminder-copy';
import type { ReminderServiceKind } from '@/lib/appointment-service-lookup';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

export type EmailTemplateKey =
  | 'confirmation'
  | 'consent_request'
  | 'reminder_lead_brows'
  | 'reminder_lead_lashes'
  | 'reminder_1h_brows'
  | 'reminder_1h_lashes'
  | 'reminder_soon_brows'
  | 'reminder_soon_lashes';

export interface EmailTemplateMeta {
  title: string;
  triggers: string[];
  allowedPlaceholders: string[];
  requiredPlaceholders: string[];
  defaultBody: string;
  sendingLive: boolean;
}

export const EMAIL_TEMPLATE_KEYS: readonly EmailTemplateKey[] = [
  'confirmation',
  'consent_request',
  'reminder_lead_brows',
  'reminder_lead_lashes',
  'reminder_1h_brows',
  'reminder_1h_lashes',
  'reminder_soon_brows',
  'reminder_soon_lashes',
] as const;

export const EMAIL_TEMPLATE_META: Record<EmailTemplateKey, EmailTemplateMeta> =
  {
    confirmation: {
      title: 'Booking confirmation',
      triggers: [
        'After checkout confirms the appointment (card vaulted).',
        'Only the warm middle paragraph is editable — greeting and 24-hour notice stay locked.',
      ],
      allowedPlaceholders: [],
      requiredPlaceholders: [],
      defaultBody:
        "You'll get a reminder with pre-arrival notes before your visit — I can't wait to see you.",
      sendingLive: true,
    },
    consent_request: {
      title: 'Consent / intake request',
      triggers: [
        'After booking confirmation when the client still needs to sign the form.',
        'Greeting stays locked; edit the instructions below it.',
      ],
      allowedPlaceholders: [],
      requiredPlaceholders: [],
      defaultBody:
        'Before your visit, please fill out and sign your intake & consent form. You can save progress and return to the same link until you sign.',
      sendingLive: true,
    },
    reminder_lead_brows: {
      title: 'Lead reminder — brows (≈48h)',
      triggers: ['QStash lead reminder for brow / non-lash services.'],
      allowedPlaceholders: ['service'],
      requiredPlaceholders: ['service'],
      defaultBody:
        "Your appointment for {{service}} is in 2 days! Please come with clean brows and no makeup. Avoid any products containing retinol or tretinoin until after your appointment. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
    reminder_lead_lashes: {
      title: 'Lead reminder — lashes (≈24h)',
      triggers: ['QStash lead reminder for lash services.'],
      allowedPlaceholders: ['service'],
      requiredPlaceholders: ['service'],
      defaultBody:
        "Your appointment for {{service}} is tomorrow! Please come with clean lashes and no eye makeup. Please refrain from drinking caffeine for at least 4-6 hours before your appointment as it can cause fluttery eyelids. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
    reminder_1h_brows: {
      title: '1-hour reminder — brows',
      triggers: ['QStash 1-hour reminder for brow / non-lash services.'],
      allowedPlaceholders: ['service'],
      requiredPlaceholders: ['service'],
      defaultBody:
        "Your appointment for {{service}} is in 1 hour! Please come with clean brows and no makeup. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
    reminder_1h_lashes: {
      title: '1-hour reminder — lashes',
      triggers: ['QStash 1-hour reminder for lash services.'],
      allowedPlaceholders: ['service'],
      requiredPlaceholders: ['service'],
      defaultBody:
        "Your appointment for {{service}} is in one hour! Please come with clean lashes and no eye makeup. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
    reminder_soon_brows: {
      title: 'Soon reminder — brows (fallback timing)',
      triggers: [
        'Rare path when the 1h job fires with a custom minutes-until window.',
      ],
      allowedPlaceholders: ['service', 'timePhrase'],
      requiredPlaceholders: ['service', 'timePhrase'],
      defaultBody:
        "Your appointment for {{service}} is {{timePhrase}}! Please come with clean brows and no makeup. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
    reminder_soon_lashes: {
      title: 'Soon reminder — lashes (fallback timing)',
      triggers: [
        'Rare path when the 1h job fires with a custom minutes-until window.',
      ],
      allowedPlaceholders: ['service', 'timePhrase'],
      requiredPlaceholders: ['service', 'timePhrase'],
      defaultBody:
        "Your appointment for {{service}} is {{timePhrase}}! Please come with clean lashes and no eye makeup. Feel free to bring earbuds with you. I'm so excited to see you!",
      sendingLive: true,
    },
  };

export const SAMPLE_EMAIL_PREVIEW_VARS: Record<string, string> = {
  service: 'Touch Up',
  timePhrase: 'in 45 minutes',
};

const MAX_BODY_LENGTH = 2000;

export function extractPlaceholders(body: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

export function renderEmailTemplate(
  body: string,
  vars: Record<string, string | null | undefined> = {}
): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

export function validateEmailBody(
  key: EmailTemplateKey,
  body: string
): { ok: true; body: string } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) {
    return { ok: false, error: 'Message body cannot be empty.' };
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      error: `Message body must be ${MAX_BODY_LENGTH} characters or fewer.`,
    };
  }

  const meta = EMAIL_TEMPLATE_META[key];
  const used = extractPlaceholders(trimmed);
  const allowed = new Set(meta.allowedPlaceholders);
  for (const token of used) {
    if (!allowed.has(token)) {
      return {
        ok: false,
        error: `Unknown placeholder {{${token}}}. Allowed: ${
          meta.allowedPlaceholders.length
            ? meta.allowedPlaceholders.map((t) => `{{${t}}}`).join(', ')
            : '(none)'
        }.`,
      };
    }
  }
  for (const required of meta.requiredPlaceholders) {
    if (!used.includes(required)) {
      return {
        ok: false,
        error: `Missing required placeholder {{${required}}}.`,
      };
    }
  }

  return { ok: true, body: trimmed };
}

export async function loadStoredEmailTemplates(): Promise<
  Partial<Record<EmailTemplateKey, string>>
> {
  try {
    const { rows } = await sql<{ email_templates: unknown }>`
      SELECT email_templates
      FROM studio_settings
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
      LIMIT 1
    `;
    const raw = rows[0]?.email_templates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Partial<Record<EmailTemplateKey, string>> = {};
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch (err) {
    // Column missing before migration — fall back to defaults.
    console.warn('[email-message-templates] load failed; using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export function effectiveEmailBody(
  key: EmailTemplateKey,
  stored?: Partial<Record<EmailTemplateKey, string>>
): string {
  const override = stored?.[key];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return EMAIL_TEMPLATE_META[key].defaultBody;
}

export async function resolveEmailCopy(
  key: EmailTemplateKey,
  vars: Record<string, string | null | undefined> = {}
): Promise<string> {
  const stored = await loadStoredEmailTemplates();
  return renderEmailTemplate(effectiveEmailBody(key, stored), vars);
}

export async function upsertEmailTemplate(
  key: EmailTemplateKey,
  body: string | null
): Promise<{ key: EmailTemplateKey; body: string; isCustom: boolean }> {
  const meta = EMAIL_TEMPLATE_META[key];
  const clear = body == null || String(body).trim() === '';
  let nextBody: string | null = null;
  if (!clear) {
    const validated = validateEmailBody(key, body);
    if (!validated.ok) {
      const err = new Error(validated.error) as Error & { code?: string };
      err.code = 'validation';
      throw err;
    }
    nextBody = validated.body;
  }

  await sql`
    INSERT INTO studio_settings (id, email_templates)
    VALUES (${STUDIO_SETTINGS_ROW_ID}, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;

  const { rows } = await sql<{ email_templates: unknown }>`
    SELECT email_templates
    FROM studio_settings
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
  `;
  const raw = rows[0]?.email_templates;
  const current: Record<string, string> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, string>) }
      : {};

  // Drop unknown / empty keys so we only keep known overrides.
  for (const existing of Object.keys(current)) {
    if (!(EMAIL_TEMPLATE_KEYS as readonly string[]).includes(existing)) {
      delete current[existing];
    }
  }

  if (clear || nextBody === meta.defaultBody) {
    delete current[key];
  } else if (nextBody) {
    current[key] = nextBody;
  }

  const serialized = JSON.stringify(current);
  await sql`
    UPDATE studio_settings
    SET
      email_templates = ${serialized}::jsonb,
      updated_at = NOW()
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
  `;

  const stored = await loadStoredEmailTemplates();
  return {
    key,
    body: effectiveEmailBody(key, stored),
    isCustom:
      typeof stored[key] === 'string' &&
      stored[key]!.trim() !== '' &&
      stored[key]!.trim() !== meta.defaultBody,
  };
}

export interface EmailTemplateCardWire {
  key: EmailTemplateKey;
  title: string;
  triggers: string[];
  allowedPlaceholders: string[];
  requiredPlaceholders: string[];
  defaultBody: string;
  body: string;
  isCustom: boolean;
  sendingLive: boolean;
  preview: string;
}

export async function listEmailTemplateCards(): Promise<EmailTemplateCardWire[]> {
  const stored = await loadStoredEmailTemplates();
  return EMAIL_TEMPLATE_KEYS.map((key) => {
    const meta = EMAIL_TEMPLATE_META[key];
    const body = effectiveEmailBody(key, stored);
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
      preview: renderEmailTemplate(body, SAMPLE_EMAIL_PREVIEW_VARS),
    };
  });
}

export function reminderEmailTemplateKey(
  kind: ReminderServiceKind,
  timing: ReminderEmailTiming
): EmailTemplateKey {
  const lash = kind === 'lashes';
  if (timing === 'lead') {
    return lash ? 'reminder_lead_lashes' : 'reminder_lead_brows';
  }
  if (timing === '1h') {
    return lash ? 'reminder_1h_lashes' : 'reminder_1h_brows';
  }
  // timing === 'immediate'
  return lash ? 'reminder_soon_lashes' : 'reminder_soon_brows';
}

export function reminderSoonTimePhrase(
  kind: ReminderServiceKind,
  minutesUntil?: number
): string {
  const minutes = Math.max(1, Math.round(minutesUntil ?? 1));
  if (minutes >= 55) {
    return kind === 'lashes' ? 'in one hour' : 'in 1 hour';
  }
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
