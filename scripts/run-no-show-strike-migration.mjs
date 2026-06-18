// Usage: node --env-file=.env.local scripts/run-no-show-strike-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS no_show_strike BOOLEAN NOT NULL DEFAULT FALSE
`);

console.log('✓ appointments.no_show_strike migration applied.');
