-- Admin iOS APNs delivery log + shared provider-token cache.
--
-- admin_push_deliveries: one row per APNs attempt (or per skipped alert) so
-- "the notification never showed up" can be traced to an Apple status code
-- instead of guessed at. Vercel only keeps ~1h of runtime logs.
--
-- admin_push_provider_token: the ES256 provider JWT shared by every
-- serverless instance. Apple rejects keys that mint a fresh token more than
-- once every 20 minutes (TooManyProviderTokenUpdates); per-instance caching
-- cannot honour that on Vercel.

CREATE TABLE IF NOT EXISTS admin_push_deliveries (
  id BIGSERIAL PRIMARY KEY,
  booking_uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- 'sent' | 'skipped' | 'invalid_token' | 'retry_scheduled' | 'rejected' | 'error'
  outcome TEXT NOT NULL,
  detail TEXT,
  apns_status INTEGER,
  apns_reason TEXT,
  apns_id TEXT,
  token_prefix TEXT,
  bundle_id TEXT,
  environment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_push_deliveries_booking_uid_idx
  ON admin_push_deliveries (booking_uid);

CREATE INDEX IF NOT EXISTS admin_push_deliveries_created_at_idx
  ON admin_push_deliveries (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_push_provider_token (
  key_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
