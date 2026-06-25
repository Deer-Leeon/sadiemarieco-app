// Usage:
//   node --env-file=.env.local scripts/run-studio-time-blocks-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  CREATE TABLE IF NOT EXISTS studio_time_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    note TEXT,
    cal_booking_uid TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT studio_time_blocks_valid_range CHECK (end_time > start_time)
  )
`);

await sql.query(`
  CREATE INDEX IF NOT EXISTS studio_time_blocks_start_time_idx
    ON studio_time_blocks (start_time)
`);

console.log('✓ studio_time_blocks migration applied.');
