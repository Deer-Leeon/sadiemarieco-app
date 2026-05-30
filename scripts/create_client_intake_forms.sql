-- ──────────────────────────────────────────────────────────────────────────
-- scripts/create_client_intake_forms.sql
--
-- Internal consent / intake form responses (replaces external Tally storage).
-- Safe to re-run (IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS client_intake_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL UNIQUE REFERENCES clients (id) ON DELETE CASCADE,
  form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_image TEXT,
  submitted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_client_intake_forms_client_id
  ON client_intake_forms (client_id);

COMMIT;
