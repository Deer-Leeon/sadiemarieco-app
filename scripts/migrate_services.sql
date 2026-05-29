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
  cal_event_id   INTEGER UNIQUE,
  category       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  price          NUMERIC(10, 2) NOT NULL DEFAULT 0,
  duration_mins  INTEGER,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  slug           TEXT,
  is_group       BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id      INTEGER REFERENCES site_services(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schema evolution: each ALTER is a no-op when the CREATE TABLE above
-- already includes the column (fresh databases), and applies the
-- additive change for any DB that ran an earlier schema. We list them
-- explicitly so the migration is unambiguous about what shape the
-- live database must end up in regardless of where it started.
--
-- `slug` — Cal.com event-type slug stored locally so the public-site
-- HTML injector can build `data-cal-link="username/slug"` attributes
-- without a Cal round-trip on every page load.
ALTER TABLE site_services ADD COLUMN IF NOT EXISTS slug TEXT;

-- `is_group` / `parent_id` — Service Groups feature. A "group" is a
-- non-bookable accordion header that nests bookable child services
-- one level deep. Groups have NO Cal.com event-type (they are
-- folders, not events), so cal_event_id and duration_mins are made
-- nullable below to accommodate them. parent_id is a self-referential
-- FK with ON DELETE CASCADE so hard-deleting a parent row also
-- removes its children — our app uses soft-delete (is_active=false),
-- but the cascade is the correct durable safety net if a row is ever
-- pruned by hand or by a future cleanup script.
ALTER TABLE site_services ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE site_services
  ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES site_services(id) ON DELETE CASCADE;

-- Menu sequence for admin + public site (lower = earlier).
ALTER TABLE site_services
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS site_services_display_order_idx
  ON site_services (display_order ASC, id ASC);

-- Loosen NOT NULL constraints on the two columns that don't apply to
-- group headers. Existing rows already have values (they were created
-- pre-feature), so the drop is purely about allowing future groups
-- to insert with NULLs. The UNIQUE constraint on cal_event_id stays —
-- Postgres treats multiple NULLs as distinct, so groups can coexist
-- without colliding.
ALTER TABLE site_services ALTER COLUMN cal_event_id DROP NOT NULL;
ALTER TABLE site_services ALTER COLUMN duration_mins DROP NOT NULL;

-- Lookup index for the common "fetch all children of group X" path
-- the admin list and public renderer both use.
CREATE INDEX IF NOT EXISTS site_services_parent_id_idx
  ON site_services (parent_id)
  WHERE parent_id IS NOT NULL;

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
