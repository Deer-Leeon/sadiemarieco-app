-- Local copy of outbound studio SMS (body as sent). Written at Twilio
-- send time — no extra Twilio API calls or fees.

CREATE TABLE IF NOT EXISTS sms_outbound_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  template_key TEXT NOT NULL,
  body TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  client_id UUID,
  client_name TEXT,
  booking_uid TEXT,
  twilio_sid TEXT
);

CREATE INDEX IF NOT EXISTS sms_outbound_log_created_at_idx
  ON sms_outbound_log (created_at DESC);
