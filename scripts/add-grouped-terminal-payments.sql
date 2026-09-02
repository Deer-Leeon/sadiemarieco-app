-- Same-day multi-appointment Terminal / cash / comp:
-- one PaymentIntent may settle several appointment_payments rows after success.
-- The in-flight (pending/processing) row stays unique per reader.

ALTER TABLE appointment_payments
  ADD COLUMN IF NOT EXISTS payment_group_id UUID;

CREATE INDEX IF NOT EXISTS appointment_payments_group_idx
  ON appointment_payments (payment_group_id)
  WHERE payment_group_id IS NOT NULL;

ALTER TABLE appointment_payments
  DROP CONSTRAINT IF EXISTS appointment_payments_stripe_payment_intent_id_key;

DROP INDEX IF EXISTS appointment_payments_stripe_payment_intent_id_key;

CREATE INDEX IF NOT EXISTS appointment_payments_pi_idx
  ON appointment_payments (stripe_payment_intent_id);

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
        AND stripe_payment_intent_id IS NOT NULL
        AND (
          stripe_reader_id IS NULL
          OR (
            stripe_reader_id IS NOT NULL
            AND (
              base_amount_cents >= 50
              OR payment_group_id IS NOT NULL
            )
          )
        )
      )
    )
  );
