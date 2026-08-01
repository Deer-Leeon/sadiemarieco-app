/**
 * Types for the singleton `studio_settings` row (id = 1).
 * See `scripts/create_studio_settings.sql`.
 */

/** The only valid primary key — enforced by CHECK (id = 1). */
export const STUDIO_SETTINGS_ROW_ID = 1 as const;

/**
 * Studio-wide settings stored as a single Postgres row.
 * `consent_pdf_url` is the public Vercel Blob URL for the global
 * consent PDF template. `sms_templates` holds admin-edited SMS bodies
 * keyed by template id (see lib/sms-templates.ts). `email_templates`
 * holds admin-edited email body paragraphs (see lib/email-message-templates.ts).
 */
export interface StudioSettings {
  id: typeof STUDIO_SETTINGS_ROW_ID;
  consent_pdf_url: string | null;
  /** Map of SmsTemplateKey → editable body (placeholders allowed). */
  sms_templates?: Record<string, string> | null;
  /** Map of EmailTemplateKey → editable body paragraph. */
  email_templates?: Record<string, string> | null;
  /**
   * Staging-only: when true, Twilio outbound SMS is allowed on the
   * staging deployment. Ignored in production.
   */
  staging_outbound_sms_enabled?: boolean;
  /** ISO 8601 timestamp string from Postgres. */
  updated_at: string;
}

/** Wire shape returned by GET /api/admin/settings/template */
export interface ConsentTemplateWire {
  consent_pdf_url: string | null;
}
