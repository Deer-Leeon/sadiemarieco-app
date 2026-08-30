// Usage:
//   node --env-file=.env.local scripts/run-add-clients-google-review-stars-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS google_review_stars SMALLINT NULL
`);

await sql.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'clients_google_review_stars_range'
    ) THEN
      ALTER TABLE clients
        ADD CONSTRAINT clients_google_review_stars_range
        CHECK (
          google_review_stars IS NULL
          OR google_review_stars BETWEEN 1 AND 5
        );
    END IF;
  END $$
`);

await sql.query(`
  UPDATE clients
  SET google_review_stars = 5
  WHERE google_review_noted IS TRUE
    AND google_review_stars IS NULL
`);

await sql.query(`
  COMMENT ON COLUMN clients.google_review_stars IS
    'Admin-entered Google review star count (1–5). NULL = not recorded. Lighting any star also marks the client as reviewed.'
`);

console.log('✓ clients google_review_stars migration applied.');
