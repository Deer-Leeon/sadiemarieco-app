// One-shot runner for the clients CRM migration.
//
// Usage:
//   node --env-file=.env.local scripts/run-clients-migration.mjs
//
// Same shape as run-migration.mjs — splits migrate_clients.sql into
// discrete statements because the Neon serverless driver only accepts
// one per call. Every statement is idempotent (IF NOT EXISTS,
// DO $$ guards, ON CONFLICT) so this script is safe to re-run against
// a database that already has the new schema.
import { sql } from '@vercel/postgres';

const STATEMENTS = [
  // Add phone column. NULL-tolerant for legacy rows; the API enforces
  // non-null for new admin-driven creates.
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`,

  // Unique constraint on phone, gated on pg_constraint lookup since
  // PG doesn't support ADD CONSTRAINT IF NOT EXISTS. The name
  // `clients_phone_key` matches the convention an inline UNIQUE would
  // have produced.
  `DO $$
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
   END $$`,

  // Backfill: assign each digits-only phone to exactly ONE clients row
  // — the row whose email appeared on the most recent appointment with
  // that phone. Any other clients rows that share the same phone in
  // the appointments history stay NULL; the admin can merge them by
  // hand from the CRM later, or a future de-dupe migration can fold
  // them.
  //
  // Why this matters: pre-feature, the webhook upserted clients
  // keyed by email alone. A single human who booked under two
  // different email addresses gets two clients rows, both pointing
  // to the same phone. A naïve "copy phone from appointments" would
  // try to write the same phone to both rows and trip the UNIQUE
  // constraint added above. The DISTINCT ON (norm_phone) inside the
  // CTE elects one winner per phone, ordered by most-recent activity.
  //
  // The trailing NOT EXISTS is belt-and-suspenders for the case where
  // some other process has already populated a phone on a different
  // row (manual SQL edit, partial earlier run, etc.) — we skip
  // backfill if doing it would collide with that existing assignment.
  `WITH phone_winners AS (
     SELECT DISTINCT ON (regexp_replace(a.client_phone, '\\D', '', 'g'))
       c.id AS client_id,
       regexp_replace(a.client_phone, '\\D', '', 'g') AS norm_phone
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
       regexp_replace(a.client_phone, '\\D', '', 'g'),
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
     )`,

  // Photos table. client_id is UUID to match clients.id (the live
  // schema uses UUIDs even though the README still documents the
  // original integer plan). The photo PK stays SERIAL because we
  // never need to expose it across systems; UUID would be overkill.
  // ON DELETE CASCADE matches the spec — purging a client wipes
  // their photo rows (the underlying blob objects need a separate
  // cleanup pass; see migrate_clients.sql header).
  `CREATE TABLE IF NOT EXISTS client_photos (
     id          SERIAL PRIMARY KEY,
     client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
     blob_url    TEXT NOT NULL,
     uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS client_photos_client_id_idx
     ON client_photos (client_id)`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log('\n✓ clients CRM migration applied.');
