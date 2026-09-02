-- Stable Cal.com event-type id on each appointment so renaming a
-- service (title change) does not orphan calendar colour, price, or
-- catalogue joins. Distinct from appointments.cal_event_id, which is
-- the Cal BOOKING UID (text).
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cal_event_type_id INTEGER NULL;

CREATE INDEX IF NOT EXISTS appointments_cal_event_type_id_idx
  ON appointments (cal_event_type_id)
  WHERE cal_event_type_id IS NOT NULL;

COMMENT ON COLUMN appointments.cal_event_type_id IS
  'Cal.com event type id (site_services.cal_event_id). Survives title renames. Not the booking UID.';

-- Prefer event-type id when snapshotting catalogue price on INSERT so a
-- rename (or a stale Cal title) cannot attach the wrong amount.
CREATE OR REPLACE FUNCTION set_appointment_quoted_service_price()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quoted_service_price_cents IS NULL THEN
    SELECT ROUND(s.price * 100)::integer
    INTO NEW.quoted_service_price_cents
    FROM site_services s
    WHERE s.is_active = TRUE
      AND (
        (
          NEW.cal_event_type_id IS NOT NULL
          AND s.cal_event_id = NEW.cal_event_type_id
        )
        OR (
          NEW.cal_event_type_id IS NULL
          AND s.title = split_part(NEW.service_name, ' between ', 1)
          AND (
            lower(trim(split_part(NEW.service_name, ' between ', 1))) NOT IN (
              'classic', 'hybrid', 'volume'
            )
            OR (
              NEW.booking_time IS NOT NULL
              AND NEW.end_time IS NOT NULL
              AND s.duration_mins IS NOT NULL
              AND s.duration_mins = GREATEST(
                1,
                ROUND(
                  EXTRACT(EPOCH FROM (NEW.end_time - NEW.booking_time)) / 60.0
                )
              )::integer
            )
          )
        )
      )
    ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;
