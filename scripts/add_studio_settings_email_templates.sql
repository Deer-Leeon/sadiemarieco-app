-- Admin-editable email body paragraphs (confirmation / reminder / consent).
-- Shape: { "confirmation": "You'll get a reminder…", "reminder_lead_brows": "…", … }
-- Empty object = use in-code defaults from lib/email-message-templates.ts.

ALTER TABLE studio_settings
  ADD COLUMN IF NOT EXISTS email_templates JSONB NOT NULL DEFAULT '{}'::jsonb;
