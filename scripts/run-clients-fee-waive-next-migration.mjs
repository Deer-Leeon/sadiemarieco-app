// Usage: node --env-file=.env.local scripts/run-clients-fee-waive-next-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS no_show_waive_next BOOLEAN NOT NULL DEFAULT TRUE
`);

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS late_change_waive_next BOOLEAN NOT NULL DEFAULT TRUE
`);

await sql.query(`
  COMMENT ON COLUMN clients.no_show_waive_next IS
    'When TRUE, the next no-show fee is waived (one-time free pass). Admin Charge always charges and clears this.'
`);

await sql.query(`
  COMMENT ON COLUMN clients.late_change_waive_next IS
    'When TRUE, the next 2h–24h late-change fee is waived (one-time free pass).'
`);

console.log('✓ clients no_show_waive_next / late_change_waive_next migration applied.');
