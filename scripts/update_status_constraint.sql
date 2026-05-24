-- ──────────────────────────────────────────────────────────────────────────
-- scripts/update_status_constraint.sql
--
-- Adds a CHECK constraint to `appointments.status` so the column can
-- only ever hold one of the four canonical lifecycle values:
--
--   • 'confirmed'           — booking is live and on the schedule.
--   • 'no-show'             — client never arrived. Stays on the
--                             calendar with a struck-through visual
--                             treatment.
--   • 'canceled_by_admin'   — McKenna cancelled from the dashboard.
--                             The admin PATCH route ALSO calls Cal.com
--                             to cancel upstream and fire Cal's native
--                             client email; the row then disappears
--                             from calendar views entirely.
--   • 'canceled_by_client'  — client cancelled via the manage portal
--                             or Cal's confirmation email link. The
--                             webhook flips the row here on
--                             BOOKING_CANCELLED. Also disappears
--                             from the calendar views.
--
-- Mirrors the `AppointmentStatus` union in `app/admin/types.ts`. If
-- you ever add or rename a status, you MUST update both this file AND
-- the TS union together — they're each the source of truth for one
-- half of the wire boundary.
--
-- Run order (one-time, idempotent):
--   1. Normalise existing rows.
--      - Legacy 'cancelled' rows (the British spelling from the
--        original webhook BOOKING_CANCELLED branch and the
--        `/api/cancel-booking` proxy) become 'canceled_by_client'
--        because every site they were written from was a
--        client-initiated cancel flow (manage portal / Cal email).
--      - Anything else NOT in the new set — including NULL — flips
--        to 'confirmed' per the migration spec ("assume existing
--        rows are 'confirmed'").
--   2. Drop the constraint if it already exists (so the script can
--      be re-run safely after a tweak).
--   3. Add the CHECK constraint.
--
-- Safe to run on a live DB: the UPDATEs are no-ops for rows already
-- in the canonical set, and the CHECK creation will succeed because
-- step 1 guarantees every row complies.
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

-- Step 1a: map legacy 'cancelled' → 'canceled_by_client'.
UPDATE appointments
SET status = 'canceled_by_client'
WHERE status = 'cancelled';

-- Step 1b: NULL / unknown values → 'confirmed' (per spec).
UPDATE appointments
SET status = 'confirmed'
WHERE status IS NULL
   OR status NOT IN (
        'confirmed',
        'no-show',
        'canceled_by_admin',
        'canceled_by_client'
      );

-- Step 2: drop any prior version of the constraint so this script
-- stays re-runnable. Postgres throws if we try to add a constraint
-- with a name that already exists.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS check_status;

-- Step 3: install the CHECK. NOT VALID is intentionally omitted —
-- step 1 already guarantees every row passes, so validating in-place
-- is cheap and saves an operator from having to remember to
-- VALIDATE it later.
ALTER TABLE appointments
  ADD CONSTRAINT check_status
  CHECK (status IN (
    'confirmed',
    'no-show',
    'canceled_by_admin',
    'canceled_by_client'
  ));

COMMIT;
