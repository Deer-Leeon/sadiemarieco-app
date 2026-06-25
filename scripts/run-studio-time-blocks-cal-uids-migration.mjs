// Usage:
//   node --env-file=.env.local scripts/run-studio-time-blocks-cal-uids-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE studio_time_blocks
    ADD COLUMN IF NOT EXISTS cal_booking_uids JSONB NOT NULL DEFAULT '[]'::jsonb
`);

await sql.query(`
  UPDATE studio_time_blocks
  SET cal_booking_uids = jsonb_build_array(cal_booking_uid)
  WHERE cal_booking_uid IS NOT NULL
    AND (cal_booking_uids IS NULL OR cal_booking_uids = '[]'::jsonb)
`);

console.log('✓ studio_time_blocks.cal_booking_uids migration applied.');
