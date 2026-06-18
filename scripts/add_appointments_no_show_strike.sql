-- Track admin no-shows marked without charging the vaulted card.
-- Incremented per appointment when PATCH status = 'no-show' and charge_no_show = false.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS no_show_strike BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN appointments.no_show_strike IS
  'True when marked no-show without charging the 50% fee (admin chose No charge).';
