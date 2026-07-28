// Usage: node --env-file=.env.local scripts/run-clients-no-show-flag-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_flag BOOLEAN NOT NULL DEFAULT FALSE
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_count IS
    'Lifetime count of appointments marked no-show (charged or not). Never decrements.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_flag IS
    'Admin-visible no-show attention flag. Set when marking no-show without a fee; clearable from the client profile.'
`);

await sql.query(`
  UPDATE clients c
  SET no_show_count = sub.cnt
  FROM (
    SELECT a.client_id AS id, COUNT(*)::int AS cnt
    FROM appointments a
    WHERE a.client_id IS NOT NULL
      AND COALESCE(LOWER(TRIM(a.status)), '') = 'no-show'
    GROUP BY a.client_id
  ) sub
  WHERE c.id = sub.id
    AND c.no_show_count = 0
`);

await sql.query(`
  UPDATE clients c
  SET no_show_flag = TRUE
  WHERE COALESCE(c.no_show_flag, FALSE) = FALSE
    AND EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.client_id = c.id
      AND COALESCE(a.no_show_strike, FALSE)
  )
`);

console.log('✓ clients.no_show_count / no_show_flag migration applied.');
