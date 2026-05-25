-- Adds nullable `stripe_setup_intent_id` for the in-progress card vault on /checkout.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS stripe_setup_intent_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointments_stripe_setup_intent_id_format_chk'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_stripe_setup_intent_id_format_chk
      CHECK (
        stripe_setup_intent_id IS NULL
        OR stripe_setup_intent_id ~ '^seti_[A-Za-z0-9]+$'
      );
  END IF;
END
$$;
