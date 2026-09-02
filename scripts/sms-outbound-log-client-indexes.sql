-- Unique Twilio SIDs so history imports are idempotent, plus lookup
-- indexes for the per-client SMS log. Also attach orphan log rows to
-- the matching client by phone.

DELETE FROM sms_outbound_log
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY twilio_sid
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM sms_outbound_log
    WHERE twilio_sid IS NOT NULL AND twilio_sid <> ''
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_outbound_log_twilio_sid_uidx
  ON sms_outbound_log (twilio_sid)
  WHERE twilio_sid IS NOT NULL AND twilio_sid <> '';

CREATE INDEX IF NOT EXISTS sms_outbound_log_client_id_created_at_idx
  ON sms_outbound_log (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sms_outbound_log_to_e164_created_at_idx
  ON sms_outbound_log (to_e164, created_at DESC);

UPDATE sms_outbound_log l
SET
  client_id = c.id,
  client_name = COALESCE(
    NULLIF(l.client_name, ''),
    NULLIF(trim(both from concat_ws(' ', c.first_name, c.last_name)), '')
  )
FROM clients c
WHERE l.client_id IS NULL
  AND regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g') <> ''
  AND (
    regexp_replace(COALESCE(l.to_e164, ''), '\D', '', 'g')
      = regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g')
    OR regexp_replace(COALESCE(l.to_e164, ''), '\D', '', 'g')
      = '1' || regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g')
    OR '1' || regexp_replace(COALESCE(l.to_e164, ''), '\D', '', 'g')
      = regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g')
  );
