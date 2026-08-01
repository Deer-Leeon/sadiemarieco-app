-- Idempotent rate-limit buckets for public API throttling.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx
  ON rate_limit_buckets (window_start);

COMMENT ON TABLE rate_limit_buckets IS
  'Fixed-window counters for public write API rate limits (keyed by route + IP/client).';
