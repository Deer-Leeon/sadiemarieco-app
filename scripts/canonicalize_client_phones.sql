-- One-time: canonicalize US client phones to 11 digits (1 + 10-digit national).
-- Run in Neon / Vercel Postgres after deploying site-wide phone normalization.
--
-- Safe to re-run: only updates 10-digit numeric phones.

UPDATE clients
SET phone = '1' || phone
WHERE phone IS NOT NULL
  AND length(phone) = 10
  AND phone ~ '^[0-9]{10}$';

-- Optional: align denormalized appointment phones the same way.
UPDATE appointments
SET client_phone = '1' || client_phone
WHERE client_phone IS NOT NULL
  AND length(regexp_replace(client_phone, '\D', '', 'g')) = 10
  AND regexp_replace(client_phone, '\D', '', 'g') ~ '^[0-9]{10}$'
  AND client_phone = regexp_replace(client_phone, '\D', '', 'g');
