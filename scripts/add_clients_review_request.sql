-- Google review SMS flags on CRM clients.
-- Existing rows stay OFF (FALSE). After backfill, new inserts default ON.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS review_request_pending BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE clients
  ALTER COLUMN review_request_pending SET DEFAULT TRUE;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS google_review_noted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS google_review_noted_at TIMESTAMPTZ NULL;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS review_request_last_sent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN clients.review_request_pending IS
  'When TRUE, send a Google review SMS ~30 minutes after the next completed confirmed visit, then clear this flag.';

COMMENT ON COLUMN clients.google_review_noted IS
  'Manual admin mark that this client already left a Google review. Not auto-detected.';

COMMENT ON COLUMN clients.google_review_noted_at IS
  'When an admin last marked google_review_noted TRUE.';

COMMENT ON COLUMN clients.review_request_last_sent_at IS
  'When the Google review-request SMS was last sent for this client.';
