// Usage:
//   node --env-file=.env.local scripts/run-booking-payment-timing-migration.mjs
import { sql } from '@vercel/postgres';

const statements = [
  `ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS payment_timing TEXT`,
  `ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT`,
  `ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_payment_timing_chk`,
  `ALTER TABLE appointments
    ADD CONSTRAINT appointments_payment_timing_chk
    CHECK (
      payment_timing IS NULL
      OR payment_timing IN ('pay_later', 'pay_now')
    )`,
  `ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_stripe_payment_intent_id_chk`,
  `ALTER TABLE appointments
    ADD CONSTRAINT appointments_stripe_payment_intent_id_chk
    CHECK (
      stripe_payment_intent_id IS NULL
      OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
    )`,
  `CREATE INDEX IF NOT EXISTS appointments_stripe_payment_intent_idx
    ON appointments (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL`,
  `ALTER TABLE appointment_payments
    DROP CONSTRAINT IF EXISTS appointment_payments_amounts_chk`,
  `ALTER TABLE appointment_payments
    ADD CONSTRAINT appointment_payments_amounts_chk
    CHECK (
      base_amount_cents >= 0
      AND tip_amount_cents >= 0
      AND total_amount_cents = base_amount_cents + tip_amount_cents
      AND (
        payment_kind IN ('cash', 'complimentary')
        OR (
          payment_kind = 'service_payment'
          AND base_amount_cents >= 50
          AND stripe_payment_intent_id IS NOT NULL
        )
      )
    )`,
];

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

console.log('\n✓ booking payment timing migration applied.');
process.exit(0);
