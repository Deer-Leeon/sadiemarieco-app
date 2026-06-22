// Usage:
//   node --env-file=.env.local scripts/run-appointments-booking-notes-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS booking_notes TEXT NULL
`);

console.log('✓ appointments.booking_notes migration applied.');
