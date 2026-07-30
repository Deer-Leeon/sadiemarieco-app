-- One-time free-pass flags for no-show and late-change fees.
-- TRUE = next eligible event is waived (skip Stripe, still count).
-- FALSE = will be charged next time.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS no_show_waive_next BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS late_change_waive_next BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN clients.no_show_waive_next IS
  'When TRUE, the next no-show fee is waived (one-time free pass). Admin Charge always charges and clears this.';

COMMENT ON COLUMN clients.late_change_waive_next IS
  'When TRUE, the next 2h–24h late-change fee is waived (one-time free pass).';
