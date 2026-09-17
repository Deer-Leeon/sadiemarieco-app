// Usage:
//   node --env-file=.env.local scripts/run-add-appointment-chair-duration-migration.mjs
import { sql } from '@vercel/postgres';

const statements = [
  `ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS chair_duration_mins INTEGER NULL`,
  `COMMENT ON COLUMN appointments.chair_duration_mins IS
    'Total chair-block minutes from booking_time when the admin extends extras or sets a custom visit length. NULL = use Cal/end_time.'`,
];

for (const statement of statements) {
  await sql.query(statement);
}

console.log('✓ appointments.chair_duration_mins migration applied.');
