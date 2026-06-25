-- Store every Cal.com segment UID for multi-part time blocks.
ALTER TABLE studio_time_blocks
  ADD COLUMN IF NOT EXISTS cal_booking_uids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE studio_time_blocks
SET cal_booking_uids = jsonb_build_array(cal_booking_uid)
WHERE cal_booking_uid IS NOT NULL
  AND (cal_booking_uids IS NULL OR cal_booking_uids = '[]'::jsonb);
