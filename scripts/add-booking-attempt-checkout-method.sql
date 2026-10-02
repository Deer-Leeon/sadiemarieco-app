-- How a public booking attempt paid, once they press Apple Pay or card.
-- Stripe overwrites this when the booking is confirmed.

ALTER TABLE booking_attempts
  ADD COLUMN IF NOT EXISTS checkout_method TEXT;
