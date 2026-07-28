-- Lifetime no-show counter (never decremented) + dismissible attention flag.
-- Flag reactivates only when an admin marks a no-show without charging.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS no_show_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS no_show_flag BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN clients.no_show_count IS
  'Lifetime count of appointments marked no-show (charged or not). Never decrements.';

COMMENT ON COLUMN clients.no_show_flag IS
  'Admin-visible no-show attention flag. Set when marking no-show without a fee; clearable from the client profile.';

-- Backfill count from current no-show appointment rows (by client_id).
UPDATE clients c
SET no_show_count = sub.cnt
FROM (
  SELECT a.client_id AS id, COUNT(*)::int AS cnt
  FROM appointments a
  WHERE a.client_id IS NOT NULL
    AND COALESCE(LOWER(TRIM(a.status)), '') = 'no-show'
  GROUP BY a.client_id
) sub
WHERE c.id = sub.id
  AND c.no_show_count = 0;

-- Backfill flag from legacy uncharged strikes (by client_id).
-- Only set TRUE when currently FALSE so re-runs do not undo admin dismissals.
UPDATE clients c
SET no_show_flag = TRUE
WHERE COALESCE(c.no_show_flag, FALSE) = FALSE
  AND EXISTS (
  SELECT 1
  FROM appointments a
  WHERE a.client_id = c.id
    AND COALESCE(a.no_show_strike, FALSE)
);
