-- Client "Additional notes" from the Cal.com booking form.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_notes TEXT NULL;

COMMENT ON COLUMN appointments.booking_notes IS
  'Optional comment the client left on the Cal.com booking form (Additional notes).';
