-- ──────────────────────────────────────────────────────────────────────────
-- scripts/add_canceled_by_client_late_status.sql
--
-- Adds 'canceled_by_client_late' for client cancellations within 24h of
-- start where the $20 late fee was charged successfully (webhook).
--
-- Mirrors `AppointmentStatus` in `app/admin/types.ts`.
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
    'canceled_by_client_late',
    'canceled_by_system'
  ));

COMMIT;
