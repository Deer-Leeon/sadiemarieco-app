-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_client_consent.sql
--
-- Tally.so medical intake / consent tracking on the CRM clients row.
-- Safe to re-run (IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS has_consented BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS consent_form_url TEXT;

COMMIT;
