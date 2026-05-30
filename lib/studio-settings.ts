/**
 * Types for the singleton `studio_settings` row (id = 1).
 * See `scripts/create_studio_settings.sql`.
 */

/** The only valid primary key — enforced by CHECK (id = 1). */
export const STUDIO_SETTINGS_ROW_ID = 1 as const;

/**
 * Studio-wide settings stored as a single Postgres row.
 * `consent_pdf_url` is the public Vercel Blob URL for the global
 * consent PDF template.
 */
export interface StudioSettings {
  id: typeof STUDIO_SETTINGS_ROW_ID;
  consent_pdf_url: string | null;
  /** ISO 8601 timestamp string from Postgres. */
  updated_at: string;
}

/** Wire shape returned by GET /api/admin/settings/template */
export interface ConsentTemplateWire {
  consent_pdf_url: string | null;
}
