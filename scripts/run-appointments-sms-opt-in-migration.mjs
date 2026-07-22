// Usage:
//   node --env-file=.env.local scripts/run-appointments-sms-opt-in-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NULL
`);

console.log('✓ appointments.sms_opt_in migration applied.');
