-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_client_notes.sql
--
-- Private admin notes per CRM client (formulas, sensitivities, etc.).
-- One row per client — upserted via PATCH /api/admin/clients/[id]/notes.
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS client_notes (
  client_id UUID PRIMARY KEY REFERENCES clients (id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
