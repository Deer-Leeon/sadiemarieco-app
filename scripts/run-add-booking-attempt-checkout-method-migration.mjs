// Usage:
//   node --env-file=.env.local scripts/run-add-booking-attempt-checkout-method-migration.mjs
import { readFileSync } from 'node:fs';
import { sql } from '@vercel/postgres';

const raw = readFileSync(
  new URL('./add-booking-attempt-checkout-method.sql', import.meta.url),
  'utf8'
);
const statements = raw
  .split(';')
  .map((part) => part.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);

console.log(`Applying ${statements.length} statements…\n`);

for (const [i, statement] of statements.entries()) {
  process.stdout.write(`[${i + 1}/${statements.length}] `);
  try {
    await sql.query(statement);
    console.log('ok');
  } catch (err) {
    console.error('FAILED');
    console.error(statement);
    console.error(err);
    process.exit(1);
  }
}

console.log('\n✓ booking_attempts.checkout_method migration applied.');
process.exit(0);
