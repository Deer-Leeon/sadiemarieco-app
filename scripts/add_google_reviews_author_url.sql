-- Stable Google review id: author_url stays the same when a review is edited
-- (Google bumps review_time on edit). Upsert on author_url instead of duplicating.

ALTER TABLE google_reviews
  ADD COLUMN IF NOT EXISTS author_url TEXT;

ALTER TABLE google_reviews
  DROP CONSTRAINT IF EXISTS google_reviews_author_time_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'google_reviews_author_url_key'
  ) THEN
    ALTER TABLE google_reviews
      ADD CONSTRAINT google_reviews_author_url_key UNIQUE (author_url);
  END IF;
END $$;
