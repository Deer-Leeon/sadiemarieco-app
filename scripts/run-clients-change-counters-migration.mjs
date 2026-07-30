// Usage: node --env-file=.env.local scripts/run-clients-change-counters-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS late_change_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS late_change_cancel_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS late_change_reschedule_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_admin_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_auto_cancel_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_auto_reschedule_count INTEGER NOT NULL DEFAULT 0
`);

await sql.query(`
  COMMENT ON COLUMN clients.late_change_count IS
    'Lifetime 2h–24h cancel/reschedule fee events. Never decrements.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.late_change_cancel_count IS
    'Lifetime 2h–24h client cancels that incurred the 50% late-change fee.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.late_change_reschedule_count IS
    'Lifetime 2h–24h client reschedules that incurred the 50% late-change fee.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_admin_count IS
    'Lifetime admin-marked no-shows (charged or waived). Part of no_show_count.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_auto_cancel_count IS
    'Lifetime under-2h client cancels charged as no-show. Part of no_show_count.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_auto_reschedule_count IS
    'Lifetime under-2h client reschedules charged as no-show. Part of no_show_count.'
`);

await sql.query(`
  UPDATE clients
  SET no_show_admin_count = no_show_count
  WHERE no_show_admin_count = 0
    AND no_show_count > 0
`);

await sql.query(`
  UPDATE clients c
  SET
    late_change_cancel_count = sub.cnt,
    late_change_count = sub.cnt + c.late_change_reschedule_count
  FROM (
    SELECT a.client_id AS id, COUNT(*)::int AS cnt
    FROM appointments a
    WHERE a.client_id IS NOT NULL
      AND COALESCE(LOWER(TRIM(a.status)), '') = 'canceled_by_client_late'
    GROUP BY a.client_id
  ) sub
  WHERE c.id = sub.id
    AND c.late_change_cancel_count = 0
`);

console.log('✓ clients late_change_* / no_show_* breakdown counters migration applied.');
