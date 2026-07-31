-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_consent_technician_reviewed.sql
--
-- Tracks when an admin marks the signed consent PDF as reviewed by the
-- technician (checks the printed ☐ Reviewed by Technician box).
-- Safe to re-run (IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS consent_technician_reviewed_at TIMESTAMPTZ;

COMMENT ON COLUMN clients.consent_technician_reviewed_at IS
  'When an admin stamped Reviewed by Technician onto the signed consent PDF.';

COMMIT;
