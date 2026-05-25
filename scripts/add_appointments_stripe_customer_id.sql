-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_appointments_stripe_customer_id.sql
--
-- Adds a nullable `stripe_customer_id` column to `appointments` so each
-- booking can link to the Stripe Customer record that holds the
-- vaulted PaymentMethod (saved via the /checkout flow).
--
-- Storage shape:
--   • NULL                   → no card on file. Legacy bookings (before
--                              card vaulting shipped) AND any future
--                              flow where the client books without
--                              hitting /checkout.
--   • 'cus_xxxxxxxxxxxxxx'   → Stripe Customer id with a PaymentMethod
--                              attached. The card can be charged off-
--                              session for late-cancel / no-show fees.
--
-- Mirrors the optional `stripe_customer_id` field on
-- `app/admin/types.ts → Appointment`. If you ever rename either side,
-- update both — they're each the source of truth for one half of the
-- wire boundary.
--
-- Safe to run on a live DB: ADD COLUMN without NOT NULL is a metadata-
-- only change on Postgres ≥ 11 (instant, no table rewrite). Idempotent
-- via IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT NULL;

DO $$
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
$$;
