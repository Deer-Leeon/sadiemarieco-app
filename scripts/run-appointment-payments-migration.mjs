// Usage:
//   node --env-file=.env.local scripts/run-appointment-payments-migration.mjs
//
// The Neon serverless driver accepts one statement per query, so this runner
// mirrors add_appointment_payments.sql as discrete idempotent statements.
import { sql } from '@vercel/postgres';

const statements = [
  `ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS quoted_service_price_cents INTEGER`,
  `CREATE OR REPLACE FUNCTION set_appointment_quoted_service_price()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   AS $$
   BEGIN
     IF NEW.quoted_service_price_cents IS NULL THEN
       SELECT ROUND(s.price * 100)::integer
       INTO NEW.quoted_service_price_cents
       FROM site_services s
       WHERE s.title = split_part(NEW.service_name, ' between ', 1)
         AND s.is_active = TRUE
         AND (
           lower(trim(split_part(NEW.service_name, ' between ', 1))) NOT IN (
             'classic', 'hybrid', 'volume'
           )
           OR (
             NEW.booking_time IS NOT NULL
             AND NEW.end_time IS NOT NULL
             AND s.duration_mins IS NOT NULL
             AND s.duration_mins = GREATEST(
               1,
               ROUND(
                 EXTRACT(EPOCH FROM (NEW.end_time - NEW.booking_time)) / 60.0
               )
             )::integer
           )
         )
       ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
       LIMIT 1;
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS appointments_snapshot_service_price
    ON appointments`,
  `CREATE TRIGGER appointments_snapshot_service_price
    BEFORE INSERT ON appointments
    FOR EACH ROW
    EXECUTE FUNCTION set_appointment_quoted_service_price()`,
  `UPDATE appointments a
   SET quoted_service_price_cents = (
     SELECT ROUND(s.price * 100)::integer
     FROM site_services s
     WHERE s.title = split_part(a.service_name, ' between ', 1)
       AND s.is_active = TRUE
       AND (
         lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
           'classic', 'hybrid', 'volume'
         )
         OR (
           a.booking_time IS NOT NULL
           AND a.end_time IS NOT NULL
           AND s.duration_mins IS NOT NULL
           AND s.duration_mins = GREATEST(
             1,
             ROUND(EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0)
           )::integer
         )
       )
     ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
     LIMIT 1
   )
   WHERE a.quoted_service_price_cents IS NULL`,
  `ALTER TABLE appointments
    DROP CONSTRAINT IF EXISTS appointments_quoted_service_price_cents_chk`,
  `ALTER TABLE appointments
    ADD CONSTRAINT appointments_quoted_service_price_cents_chk
    CHECK (
      quoted_service_price_cents IS NULL
      OR quoted_service_price_cents >= 0
    )`,
  `CREATE TABLE IF NOT EXISTS appointment_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id TEXT NOT NULL,
    cal_booking_uid TEXT,
    payment_kind TEXT NOT NULL DEFAULT 'service_payment',
    stripe_payment_intent_id TEXT NOT NULL UNIQUE,
    stripe_reader_id TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    base_amount_cents INTEGER NOT NULL,
    tip_amount_cents INTEGER NOT NULL DEFAULT 0,
    total_amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    failure_code TEXT,
    failure_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    CONSTRAINT appointment_payments_kind_chk
      CHECK (payment_kind IN ('service_payment')),
    CONSTRAINT appointment_payments_status_chk
      CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
    CONSTRAINT appointment_payments_currency_chk
      CHECK (currency ~ '^[a-z]{3}$'),
    CONSTRAINT appointment_payments_amounts_chk
      CHECK (
        base_amount_cents >= 50
        AND tip_amount_cents >= 0
        AND total_amount_cents >= base_amount_cents
      ),
    CONSTRAINT appointment_payments_pi_format_chk
      CHECK (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
    CONSTRAINT appointment_payments_reader_format_chk
      CHECK (stripe_reader_id ~ '^tmr_[A-Za-z0-9_]+$')
  )`,
  `CREATE INDEX IF NOT EXISTS appointment_payments_appointment_idx
    ON appointment_payments (appointment_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appointment_payments_one_active_service_idx
    ON appointment_payments (appointment_id)
    WHERE payment_kind = 'service_payment'
      AND status IN ('pending', 'processing', 'succeeded', 'failed')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appointment_payments_one_active_reader_idx
    ON appointment_payments (stripe_reader_id)
    WHERE status IN ('pending', 'processing')`,
];

for (const statement of statements) {
  process.stdout.write(`→ ${statement.replace(/\s+/g, ' ').slice(0, 76)}…\n`);
  await sql.query(statement);
}

console.log('\n✓ appointment_payments migration applied.');
