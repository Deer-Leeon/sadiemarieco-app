-- Admin iOS APNs device tokens. One row per physical device token.
-- Unique on device_token so re-login / token rotate upserts in place.

CREATE TABLE IF NOT EXISTS admin_push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  device_token TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_push_devices_token_uniq UNIQUE (device_token),
  CONSTRAINT admin_push_devices_environment_chk
    CHECK (environment IN ('development', 'production')),
  CONSTRAINT admin_push_devices_token_format_chk
    CHECK (device_token ~ '^[A-Fa-f0-9]{64,200}$')
);

CREATE INDEX IF NOT EXISTS admin_push_devices_email_idx
  ON admin_push_devices (email);

CREATE INDEX IF NOT EXISTS admin_push_devices_updated_at_idx
  ON admin_push_devices (updated_at DESC);
