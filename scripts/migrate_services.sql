-- ---------------------------------------------------------------------------
-- site_services
--
-- Local mirror of the studio's Cal.com event-types. The /admin/services
-- CMS is the single editing surface — every write goes to Cal.com first
-- (so the booking page reflects the change immediately) and is then
-- mirrored into this table so the public site can render the menu
-- without an extra Cal.com round-trip on every page load.
--
-- Field notes:
--   cal_event_id   The numeric id returned by POST /v1/event-types. Used
--                  as the join key for PATCH (update) and "hide" (soft
--                  delete) operations on the Cal.com side. UNIQUE because
--                  a given Cal event maps to exactly one local row.
--
--   category       Free-text grouping label ("Lash Services", "Brow
--                  Services", ...). Kept as text rather than a FK to a
--                  categories table because the studio adds/renames
--                  categories on the fly and a join would just be
--                  paperwork at this scale (<50 services).
--
--   price          Stored in dollars as NUMERIC(10,2) so we don't lose
--                  cents to floating point. Cal.com itself doesn't manage
--                  payments for this account, so price is local-only;
--                  Cal stores the duration and metadata, we store the
--                  customer-facing rate.
--
--   duration_mins  Mirrors Cal.com's `length` field. We keep our column
--                  named after the user-facing unit so SQL queries read
--                  naturally ("WHERE duration_mins > 60"), and translate
--                  to/from `length` at the API boundary.
--
--   is_active      Soft-delete flag. The DELETE endpoint hides the event
--                  in Cal.com (`hidden: true`) AND flips this to false
--                  so the row stays for history/audit but disappears
--                  from /admin/services and the public menu.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS site_services (
  id             SERIAL PRIMARY KEY,
  cal_event_id   INTEGER UNIQUE NOT NULL,
  category       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  price          NUMERIC(10, 2) NOT NULL DEFAULT 0,
  duration_mins  INTEGER NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  slug           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schema evolution: `slug` was added after the initial migration so
-- existing rows don't have the column yet. The ALTER is a no-op for
-- fresh databases (where the CREATE above already includes it) but
-- required for any DB that ran the original schema.
--
-- We store the Cal.com event-type slug locally so the public-site
-- HTML injector can build `data-cal-link="username/slug"` attributes
-- without an extra round-trip to Cal on every page load. Nullable
-- because the slug isn't known until POST /event-types returns —
-- and we want the row to exist even if a future change ever needs
-- to defer slug assignment.
ALTER TABLE site_services ADD COLUMN IF NOT EXISTS slug TEXT;

-- Query pattern the admin UI uses on every page load:
--   SELECT … FROM site_services WHERE is_active = TRUE ORDER BY category, title
-- This composite index makes that an index-only scan.
CREATE INDEX IF NOT EXISTS site_services_active_category_title_idx
  ON site_services (category, title)
  WHERE is_active = TRUE;

-- updated_at maintenance — no application code needs to remember to bump
-- the column. PATCH handlers SET other columns and the trigger handles
-- the timestamp.
CREATE OR REPLACE FUNCTION site_services_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS site_services_touch_updated_at_trg ON site_services;
CREATE TRIGGER site_services_touch_updated_at_trg
  BEFORE UPDATE ON site_services
  FOR EACH ROW
  EXECUTE FUNCTION site_services_touch_updated_at();
