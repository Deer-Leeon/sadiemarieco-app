-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_site_images_caption.sql
--
-- Adds a nullable `caption` column to `site_images` so each CMS slot can
-- carry an editable subtitle. Currently only the five Portfolio &
-- Gallery tiles render their caption on the public site (via the
-- `.p-tag` overlay), but the column lives on every row so any slot can
-- pick up a caption in the future without another migration.
--
-- Behaviour (see `app/route.ts` injectCaptions):
--   • NULL        = keep the hardcoded `.p-tag` in public/index.html
--   • '' (empty)  = hide the tag and bottom gradient for that tile
--   • other text  = custom caption on the live site
--
-- Run once in the Vercel Postgres console (or `psql $POSTGRES_URL -f …`).
--
-- Safe to run on a live DB: ADD COLUMN with no NOT NULL constraint is
-- a metadata-only change on Postgres ≥ 11 (instant, no table rewrite).
-- Idempotent via IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE site_images
  ADD COLUMN IF NOT EXISTS caption TEXT NULL;
