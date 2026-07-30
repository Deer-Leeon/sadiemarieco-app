-- Optional staging-only switch for real Twilio sends.
-- Production never reads this column (outbound SMS is always on there).
-- Default false so Sunday Neon resets leave staging silent until an admin
-- explicitly re-enables testing.

ALTER TABLE studio_settings
  ADD COLUMN IF NOT EXISTS staging_outbound_sms_enabled BOOLEAN NOT NULL DEFAULT false;
