-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_canceled_by_system_status.sql
--
-- Amends the `check_status` CHECK constraint on `appointments` to allow
-- a sixth value, 'canceled_by_system'. Written by the
-- `/api/qstash/release-hold` (delayed from `/api/booking/init`) when a 'pending' row
-- has been sitting for longer than the abandonment window without a
-- vaulted card — the row stays in the DB for drop-off analytics, but
-- the Cal.com hold is released upstream so the slot is bookable again.
--
-- Delta on top of the prior migrations:
--   ('pending', 'confirmed', 'no-show', 'canceled_by_admin', 'canceled_by_client')
--     becomes
--   ('pending', 'confirmed', 'no-show', 'canceled_by_admin',
--    'canceled_by_client', 'canceled_by_system')
--
-- Mirrors the `AppointmentStatus` union in `app/admin/types.ts`. If you
-- add a status, update both this file AND the TS union together —
-- they're each the source of truth for one half of the wire boundary.
--
-- Safe on a live DB: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT with a
-- value-set that's a strict superset of the prior set will never reject
-- an existing row. No row-rewriting; the constraint is checked at write
-- time only.
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS check_status;

ALTER TABLE appointments
  ADD CONSTRAINT check_status
  CHECK (status IN (
    'pending',
    'confirmed',
    'no-show',
    'canceled_by_admin',
    'canceled_by_client',
    'canceled_by_system'
  ));

COMMIT;
