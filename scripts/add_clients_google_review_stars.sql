-- Manual Google star rating on CRM clients (1–5).
-- NULL means no review recorded. Existing google_review_noted=TRUE rows
-- backfill to 5 so they still show as reviewed.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS google_review_stars SMALLINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'clients_google_review_stars_range'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_google_review_stars_range
      CHECK (
        google_review_stars IS NULL
        OR google_review_stars BETWEEN 1 AND 5
      );
  END IF;
END $$;

UPDATE clients
SET google_review_stars = 5
WHERE google_review_noted IS TRUE
  AND google_review_stars IS NULL;

COMMENT ON COLUMN clients.google_review_stars IS
  'Admin-entered Google review star count (1–5). NULL = not recorded. Lighting any star also marks the client as reviewed.';
