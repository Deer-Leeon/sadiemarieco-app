-- Attached extras: catalogue work done during an existing visit.
-- Child rows share the parent's client + times, have no Cal.com booking,
-- and are hidden from calendar queries via attached_to_appointment_id IS NULL.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS attached_to_appointment_id UUID NULL;

ALTER TABLE appointments
  ALTER COLUMN cal_event_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointments_attached_to_appointment_id_fkey'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_attached_to_appointment_id_fkey
      FOREIGN KEY (attached_to_appointment_id)
      REFERENCES appointments(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS appointments_attached_to_idx
  ON appointments (attached_to_appointment_id)
  WHERE attached_to_appointment_id IS NOT NULL;

COMMENT ON COLUMN appointments.attached_to_appointment_id IS
  'Parent calendar visit when this row is a catalogue extra done during that visit. NULL for standalone bookings.';
