-- scripts/add_site_services_display_order.sql
--
-- Adds display_order for admin-controlled service menu sequencing.
-- Run once against Neon / production Postgres.

ALTER TABLE site_services
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

-- Backfill: preserve the legacy admin sort (category, groups first, title).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      ORDER BY category ASC, is_group DESC, title ASC, id ASC
    ) - 1 AS ord
  FROM site_services
)
UPDATE site_services AS s
SET display_order = r.ord
FROM ranked AS r
WHERE s.id = r.id;

CREATE INDEX IF NOT EXISTS site_services_display_order_idx
  ON site_services (display_order ASC, id ASC);
