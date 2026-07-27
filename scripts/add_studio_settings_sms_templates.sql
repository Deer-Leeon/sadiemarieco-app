-- Add admin-editable SMS template bodies to the studio_settings singleton.
-- Shape: { "confirmation": "Your {{service}} is…", "reminder_24h": "…", … }
-- Empty object = use in-code defaults from lib/sms-templates.js.

ALTER TABLE studio_settings
  ADD COLUMN IF NOT EXISTS sms_templates JSONB NOT NULL DEFAULT '{}'::jsonb;
