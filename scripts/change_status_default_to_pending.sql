-- ──────────────────────────────────────────────────────────────────────────
-- scripts/change_status_default_to_pending.sql
--
-- Switches the `appointments.status` column DEFAULT from 'confirmed' to
-- 'pending' so any future INSERT that forgets to specify status lands
-- safely in the "card not yet vaulted" state instead of squatting on
-- the calendar as confirmed.
--
-- Background: the column was created with DEFAULT 'confirmed' back when
-- every booking auto-confirmed (pre-card-vaulting). Now the canonical
-- state machine is:
--   webhook INSERT  → 'pending'
--   /checkout       → '/api/booking/confirm' flips to 'confirmed'
--   cron sweep      → flips abandoned rows to 'canceled_by_system'
-- All paths explicitly set status, so the DEFAULT is purely a safety
-- net — but the OLD default ('confirmed') was the WRONG safety net.
--
-- Safe on a live DB: column-default changes are metadata-only on
-- Postgres ≥ 11 (no table rewrite, instant). Does NOT touch existing
-- rows — the historical 'confirmed' rows already in the DB stay
-- unchanged.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ALTER COLUMN status SET DEFAULT 'pending';
