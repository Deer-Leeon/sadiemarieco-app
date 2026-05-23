-- ─────────────────────────────────────────────────────────────────────────
-- migrate_clients.sql
--
-- Adds the phone-based identifier the admin Client CRM keys off, and the
-- client_photos table that backs the photo gallery in ClientProfileModal.
--
-- Schema evolution rather than a clean CREATE: the clients table predates
-- this feature (originally email-keyed, populated by api/webhook.js on
-- BOOKING_CREATED). Every statement is wrapped in IF NOT EXISTS / DO $$
-- guards so this script is safe to re-run against a database that already
-- has the new columns/constraints in place.
--
-- Identifier discipline:
--   * `clients.email` keeps its existing UNIQUE NOT NULL — webhook-driven
--     creation still works exactly as before.
--   * `clients.phone` is the NEW unique identifier the admin CRM uses.
--     Nullable in the schema (legacy rows from before this feature
--     don't have one) but the API layer treats NULL as "needs backfill"
--     and never allows a new admin-driven create without a phone.
--   * Postgres treats multiple NULLs in a UNIQUE column as distinct, so
--     legacy rows coexist with the constraint without colliding.
--
-- Backfill: existing `clients` rows get a phone copied from their most
-- recent appointment that DID carry one. This is critical for "First-
-- Touch Lock-in" — without the backfill, the admin opening an existing
-- client's appointment would create a SECOND clients row keyed by phone
-- because the email-matched row had phone=NULL.
--
-- De-duplication: a single human who booked under two different email
-- addresses pre-feature has TWO clients rows but ONE real phone — the
-- naïve backfill would try to assign the same phone to both rows and
-- trip the UNIQUE constraint above. The CTE elects one winner per
-- normalised phone (the row whose email appeared on the most recent
-- appointment with that phone) and only backfills the winner. The
-- losing rows stay phone=NULL; the admin can merge them by hand from
-- the CRM later, or a future migration can fold them.
-- ─────────────────────────────────────────────────────────────────────────

-- Phone column. Sized at VARCHAR(20) per the spec — comfortably fits
-- E.164 (+ up to 15 digits) plus a few characters of slack for legacy
-- imports. Normalised to digits-only by the API before insert.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

-- Unique constraint on phone. PG doesn't support `ADD CONSTRAINT IF NOT
-- EXISTS` directly, so we gate the ADD on a pg_constraint lookup. The
-- constraint name `clients_phone_key` is the convention PG would use for
-- ALTER COLUMN ADD UNIQUE — we use it explicitly so future migrations
-- can reference the same name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'clients_phone_key'
      AND conrelid = 'clients'::regclass
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_phone_key UNIQUE (phone);
  END IF;
END $$;

-- Backfill: most recent appointment per client_email becomes that
-- client's phone. We compare normalised-to-digits on the appointment
-- side (Cal sends phone numbers however the booking form was filled
-- in, often with +, spaces, or dashes) so the result matches what the
-- API stores going forward. Skips rows that already have a phone (so
-- a partial earlier run plus a re-run is idempotent) and any clients
-- whose email doesn't appear with a phone in any appointment.
WITH phone_winners AS (
  SELECT DISTINCT ON (regexp_replace(a.client_phone, '\D', '', 'g'))
    c.id AS client_id,
    regexp_replace(a.client_phone, '\D', '', 'g') AS norm_phone
  FROM appointments a
  JOIN clients c
    ON c.email IS NOT NULL
   AND LOWER(TRIM(c.email)) = LOWER(TRIM(a.client_email))
  WHERE a.client_phone IS NOT NULL
    AND TRIM(a.client_phone) <> ''
    AND a.client_email IS NOT NULL
    AND TRIM(a.client_email) <> ''
    AND c.phone IS NULL
  ORDER BY
    regexp_replace(a.client_phone, '\D', '', 'g'),
    a.booking_time DESC NULLS LAST
)
UPDATE clients c
SET phone = pw.norm_phone
FROM phone_winners pw
WHERE c.id = pw.client_id
  AND c.phone IS NULL
  AND pw.norm_phone <> ''
  AND NOT EXISTS (
    SELECT 1 FROM clients c2
    WHERE c2.phone = pw.norm_phone
  );

-- Photos table. blob_url stores the public URL returned by @vercel/blob
-- so the admin UI can render <img src=...> directly. uploaded_at lets
-- the grid sort newest-first without a separate index — small studio,
-- a few dozen photos per client at most, no pagination needed.
--
-- Type note: client_id is UUID, NOT integer, to match the live
-- clients.id (UUID via @vercel/postgres' gen_random_uuid() default in
-- the historical migration). The README's `id SERIAL PRIMARY KEY` for
-- clients is out of date — see information_schema.columns for the
-- ground truth.
--
-- ON DELETE CASCADE: when a client row is purged (rare, GDPR-style
-- "delete my data" request) the photos go with them. The corresponding
-- blob objects are NOT removed by this cascade — a future cleanup
-- script would need to walk client_photos.blob_url and call
-- @vercel/blob's `del()` before deleting the DB rows.
CREATE TABLE IF NOT EXISTS client_photos (
  id          SERIAL PRIMARY KEY,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  blob_url    TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup index for "all photos for this client" — the single hottest
-- query path on this table.
CREATE INDEX IF NOT EXISTS client_photos_client_id_idx
  ON client_photos (client_id);
