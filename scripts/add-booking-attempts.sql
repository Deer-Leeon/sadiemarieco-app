-- Public booking attempts for /admin/funnel.
-- One row per person opening the phone booker or the desktop service drawer.
-- No name, phone, or email. Linked to an appointment only after a hold exists.

CREATE TABLE IF NOT EXISTS booking_attempts (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  service_label TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_step TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  appointment_id UUID,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT booking_attempts_surface_check
    CHECK (surface IN ('phone', 'desktop'))
);

CREATE INDEX IF NOT EXISTS booking_attempts_started_at_idx
  ON booking_attempts (started_at DESC);

CREATE INDEX IF NOT EXISTS booking_attempts_appointment_id_idx
  ON booking_attempts (appointment_id);
