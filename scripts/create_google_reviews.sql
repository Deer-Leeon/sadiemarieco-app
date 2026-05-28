-- google_reviews — synced from Google Places Details (see
-- app/api/cron/sync-reviews/route.ts). Dedup via UNIQUE (author_name,
-- review_time) because Google does not expose stable review ids.

CREATE TABLE IF NOT EXISTS google_reviews (
  id                SERIAL PRIMARY KEY,
  author_name       TEXT NOT NULL,
  profile_photo_url TEXT,
  rating            INTEGER NOT NULL,
  review_text       TEXT NOT NULL,
  review_time       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT google_reviews_author_time_key UNIQUE (author_name, review_time)
);
