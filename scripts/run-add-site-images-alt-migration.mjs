/**
 * Add site_images.alt_text, file_name, and photo_subject.
 *
 * Usage (from repo root, with .env.local present):
 *   node --env-file=.env.local scripts/run-add-site-images-alt-migration.mjs
 *
 * Safe to re-run.
 */
import { sql } from '@vercel/postgres';

const statements = [
  `ALTER TABLE site_images ADD COLUMN IF NOT EXISTS alt_text TEXT`,
  `ALTER TABLE site_images ADD COLUMN IF NOT EXISTS file_name TEXT`,
  `ALTER TABLE site_images ADD COLUMN IF NOT EXISTS photo_subject TEXT`,
];

for (const statement of statements) {
  await sql.query(statement);
  console.log('ok', statement);
}

console.log('site_images photo metadata columns are ready');
