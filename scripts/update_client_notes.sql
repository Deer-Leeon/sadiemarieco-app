-- ──────────────────────────────────────────────────────────────────────────
-- scripts/update_client_notes.sql
--
-- Upgrade client_notes from one row per client to an append-only history
-- with optional pinning. Safe to re-run (IF NOT EXISTS guards).
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE client_notes
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;

DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'client_notes'
      AND column_name = 'id'
  ) THEN
    ALTER TABLE client_notes RENAME TO client_notes_legacy;

    CREATE TABLE client_notes (
      id SERIAL PRIMARY KEY,
      client_id UUID NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
      notes TEXT NOT NULL DEFAULT '',
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO client_notes (client_id, notes, created_at, is_pinned)
    SELECT
      client_id,
      notes,
      COALESCE(updated_at, NOW()),
      false
    FROM client_notes_legacy;

    DROP TABLE client_notes_legacy;
  END IF;
END
$migrate$;

ALTER TABLE client_notes
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_notes_client_pinned_created
  ON client_notes (client_id, is_pinned DESC, created_at DESC);

COMMIT;
