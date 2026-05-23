// One-shot runner for the site_services migration.
//
// Usage:
//   node --env-file=.env.local scripts/run-migration.mjs
//
// Uses @vercel/postgres (the same client our app uses). The Neon
// serverless driver only accepts one statement per query, so we
// split the migration into discrete logical statements here rather
// than feeding the whole SQL file as one blob.
//
// Idempotent — safe to re-run. Each statement uses `IF NOT EXISTS`
// (or `CREATE OR REPLACE` for the trigger function).
import { sql } from '@vercel/postgres';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS site_services (
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
   )`,

  `ALTER TABLE site_services ADD COLUMN IF NOT EXISTS slug TEXT`,
  `ALTER TABLE site_services ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE site_services
     ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES site_services(id) ON DELETE CASCADE`,
  `ALTER TABLE site_services ALTER COLUMN cal_event_id DROP NOT NULL`,
  `ALTER TABLE site_services ALTER COLUMN duration_mins DROP NOT NULL`,

  `CREATE INDEX IF NOT EXISTS site_services_active_category_title_idx
     ON site_services (category, title)
     WHERE is_active = TRUE`,

  `CREATE INDEX IF NOT EXISTS site_services_parent_id_idx
     ON site_services (parent_id)
     WHERE parent_id IS NOT NULL`,

  `CREATE OR REPLACE FUNCTION site_services_touch_updated_at()
   RETURNS TRIGGER AS $$
   BEGIN
     NEW.updated_at := NOW();
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,

  `DROP TRIGGER IF EXISTS site_services_touch_updated_at_trg ON site_services`,

  `CREATE TRIGGER site_services_touch_updated_at_trg
     BEFORE UPDATE ON site_services
     FOR EACH ROW
     EXECUTE FUNCTION site_services_touch_updated_at()`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log('\n✓ site_services migration applied.');
