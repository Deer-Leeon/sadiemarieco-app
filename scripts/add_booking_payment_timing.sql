-- Phone /book pay-now vs pay-later:
--   • appointments.payment_timing — chosen at confirm (pay_later | pay_now)
--   • appointments.stripe_payment_intent_id — online prepaid PaymentIntent
--   • appointment_payments.service_payment may omit stripe_reader_id when
--     the charge was online (Apple Pay / card at booking), not Terminal.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS payment_timing TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_payment_timing_chk;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_payment_timing_chk
  CHECK (
    payment_timing IS NULL
    OR payment_timing IN ('pay_later', 'pay_now')
  );

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_stripe_payment_intent_id_chk;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_stripe_payment_intent_id_chk
  CHECK (
    stripe_payment_intent_id IS NULL
    OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
  );

CREATE INDEX IF NOT EXISTS appointments_stripe_payment_intent_idx
  ON appointments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Online prepaid: PI required, reader optional (Terminal still supplies reader).
ALTER TABLE appointment_payments
  DROP CONSTRAINT IF EXISTS appointment_payments_amounts_chk;

ALTER TABLE appointment_payments
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
  );
