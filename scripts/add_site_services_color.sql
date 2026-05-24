-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_site_services_color.sql
--
-- Adds a nullable `color` column to `site_services` so each service can
-- carry an editor-assigned hex code used for appointment chrome on the
-- admin calendar (list / 3-day / week / month / single-day modal /
-- client profile history).
--
-- Storage shape:
--   • NULL  → "no explicit colour set". The runtime in
--     `app/admin/serviceColors.ts` falls back to its keyword + duration
--     auto-matcher so legacy rows (and any service the editor never
--     customises) keep the same colours they had before this column
--     existed. No behavioural change until the editor picks one.
--   • '#RRGGBB' → "use this exact hex". Wins over the auto-matcher.
--     The CHECK constraint enforces the canonical 7-char form so a
--     malformed value (`'red'`, `'#fff'`, `'rgb(0,0,0)'`) can never
--     reach the calendar and break the YIQ contrast calculation.
--
-- Safe to run on a live DB: ADD COLUMN with no NOT NULL constraint is
-- a metadata-only change on Postgres ≥ 11 (instant, no table rewrite).
-- Idempotent via IF NOT EXISTS on the column and the constraint
-- (constraint guarded by NOT EXISTS lookup in pg_constraint).
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE site_services
  ADD COLUMN IF NOT EXISTS color TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'site_services_color_format_chk'
  ) THEN
    ALTER TABLE site_services
      ADD CONSTRAINT site_services_color_format_chk
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END
$$;
