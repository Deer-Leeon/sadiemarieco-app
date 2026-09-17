-- Chair duration: admin-set visit length (minutes from booking_time).
-- When set, public occupancy and calendar pills use this instead of the
-- Cal.com event-type length. Null means derive from end_time as today.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS chair_duration_mins INTEGER NULL;

COMMENT ON COLUMN appointments.chair_duration_mins IS
  'Total chair-block minutes from booking_time when the admin extends extras or sets a custom visit length. NULL = use Cal/end_time.';
