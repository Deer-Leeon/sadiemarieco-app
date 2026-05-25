// One-shot runner for the appointments.stripe_customer_id migration.
//
// Usage:
//   node --env-file=.env.local scripts/run-stripe-customer-id-migration.mjs
//
// Uses @vercel/postgres (the same client our app uses). The Neon
// serverless driver only accepts one statement per query, so we split
// the migration into discrete logical statements here rather than
// feeding the whole .sql file as one blob.
//
// Idempotent — safe to re-run. Both statements use `IF NOT EXISTS`
// (or the pg_constraint guard for the CHECK).
import { sql } from '@vercel/postgres';

const STATEMENTS = [
  // Add the nullable column. Metadata-only on Postgres ≥ 11 (no table
  // rewrite). NULL means "no card on file" — legacy bookings + any
  // future flow that bypasses /checkout.
  `ALTER TABLE appointments
     ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT NULL`,

  // Format CHECK so a malformed customer id (e.g. an unprefixed string
  // from a future SDK change) can't sneak in via /api/booking/confirm.
  // Wrapped in DO so the script stays re-runnable on PG < 16 where
  // ADD CONSTRAINT doesn't support IF NOT EXISTS.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'appointments_stripe_customer_id_format_chk'
     ) THEN
       ALTER TABLE appointments
         ADD CONSTRAINT appointments_stripe_customer_id_format_chk
         CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$');
     END IF;
   END
   $$`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log('\n✓ appointments.stripe_customer_id migration applied.');
