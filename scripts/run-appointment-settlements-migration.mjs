// Usage:
//   node --env-file=.env.local scripts/run-appointment-settlements-migration.mjs
//
// Neon serverless accepts one statement per query — mirrors
// add_appointment_settlements.sql as discrete idempotent statements.
import { sql } from '@vercel/postgres';

const statements = [
  `ALTER TABLE appointment_payments
    ADD COLUMN IF NOT EXISTS note TEXT`,
  `ALTER TABLE appointment_payments
    ADD COLUMN IF NOT EXISTS settled_by_email TEXT`,
  `ALTER TABLE appointment_payments
    ALTER COLUMN stripe_payment_intent_id DROP NOT NULL`,
  `ALTER TABLE appointment_payments
    ALTER COLUMN stripe_reader_id DROP NOT NULL`,
  `ALTER TABLE appointment_payments
    DROP CONSTRAINT IF EXISTS appointment_payments_kind_chk`,
  `ALTER TABLE appointment_payments
    ADD CONSTRAINT appointment_payments_kind_chk
    CHECK (payment_kind IN ('service_payment', 'cash', 'complimentary'))`,
  `ALTER TABLE appointment_payments
    DROP CONSTRAINT IF EXISTS appointment_payments_amounts_chk`,
  `UPDATE appointment_payments
    SET total_amount_cents = base_amount_cents + tip_amount_cents
    WHERE total_amount_cents <> base_amount_cents + tip_amount_cents`,
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
          AND stripe_reader_id IS NOT NULL
        )
      )
    )`,
  `ALTER TABLE appointment_payments
    DROP CONSTRAINT IF EXISTS appointment_payments_pi_format_chk`,
  `ALTER TABLE appointment_payments
    ADD CONSTRAINT appointment_payments_pi_format_chk
    CHECK (
      stripe_payment_intent_id IS NULL
      OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
    )`,
  `ALTER TABLE appointment_payments
    DROP CONSTRAINT IF EXISTS appointment_payments_reader_format_chk`,
  `ALTER TABLE appointment_payments
    ADD CONSTRAINT appointment_payments_reader_format_chk
    CHECK (
      stripe_reader_id IS NULL
      OR stripe_reader_id ~ '^tmr_[A-Za-z0-9_]+$'
    )`,
  `DROP INDEX IF EXISTS appointment_payments_one_active_service_idx`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appointment_payments_one_active_service_idx
    ON appointment_payments (appointment_id)
    WHERE payment_kind = 'service_payment'
      AND status IN ('pending', 'processing', 'failed')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appointment_payments_one_succeeded_idx
    ON appointment_payments (appointment_id)
    WHERE status = 'succeeded'`,
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

console.log('\n✓ appointment_settlements migration applied.');
process.exit(0);
