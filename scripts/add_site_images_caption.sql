-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_site_images_caption.sql
--
-- Adds a nullable `caption` column to `site_images` so each CMS slot can
-- carry an editable subtitle. Currently only the five Portfolio &
-- Gallery tiles render their caption on the public site (via the
-- `.p-tag` overlay), but the column lives on every row so any slot can
-- pick up a caption in the future without another migration.
--
-- Behaviour:
--   • NULL = "use the hardcoded default that's already baked into
--     public/index.html". The server route in `app/route.ts` leaves
--     the `.p-tag` text untouched when no caption is set, so existing
--     deployments look identical until an admin saves a custom value.
--   • A non-NULL value REPLACES the hardcoded text on the next public
--     page render (single-flight, no CDN cache — see app/route.ts).
--
-- Safe to run on a live DB: ADD COLUMN with no NOT NULL constraint is
-- a metadata-only change on Postgres ≥ 11 (instant, no table rewrite).
-- Idempotent via IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE site_images
  ADD COLUMN IF NOT EXISTS caption TEXT NULL;
