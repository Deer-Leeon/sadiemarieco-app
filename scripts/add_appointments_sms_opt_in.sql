ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NULL;

COMMENT ON COLUMN appointments.sms_opt_in IS
  'Explicit Cal sms-consent checkbox. TRUE = send transactional SMS; FALSE/NULL = do not (A2P).';
