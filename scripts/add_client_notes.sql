-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_client_notes.sql
--
-- Private admin notes per CRM client (formulas, sensitivities, etc.).
-- Legacy bootstrap (superseded by scripts/update_client_notes.sql for history + pinning).
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS client_notes (
  client_id UUID PRIMARY KEY REFERENCES clients (id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
