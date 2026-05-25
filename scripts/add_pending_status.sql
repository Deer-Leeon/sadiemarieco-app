-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_pending_status.sql
--
-- Amends the `check_status` CHECK constraint on `appointments` so a fifth
-- value, 'pending', is allowed. 'pending' represents a booking the
-- Cal.com webhook inserted but for which the client hasn't completed
-- the card-vaulting handoff at /checkout yet. The /api/booking/confirm
-- route flips the row to 'confirmed' once the SetupIntent succeeds and
-- Cal acknowledges the booking.
--
-- This is a delta on top of the original `update_status_constraint.sql`
-- migration:
--   ('confirmed', 'no-show', 'canceled_by_admin', 'canceled_by_client')
--     becomes
--   ('pending', 'confirmed', 'no-show', 'canceled_by_admin', 'canceled_by_client')
--
-- Mirrors the `AppointmentStatus` union in `app/admin/types.ts`. If you
-- ever rename or add a status, you MUST update both this file AND the
-- TS union together — they're each the source of truth for one half
-- of the wire boundary.
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
    'canceled_by_client'
  ));

COMMIT;
