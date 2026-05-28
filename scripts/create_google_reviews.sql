-- google_reviews — synced from Google Places Details (see
-- app/api/cron/sync-reviews/route.ts). Upsert on author_url (stable when
-- Google edits bump review_time).

CREATE TABLE IF NOT EXISTS google_reviews (
  id                SERIAL PRIMARY KEY,
  author_name       TEXT NOT NULL,
  author_url        TEXT UNIQUE,
  profile_photo_url TEXT,
  rating            INTEGER NOT NULL,
  review_text       TEXT NOT NULL,
  review_time       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
