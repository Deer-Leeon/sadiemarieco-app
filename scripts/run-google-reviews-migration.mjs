// One-shot runner for the google_reviews table migration.
//
// Usage:
//   node --env-file=.env.local scripts/run-google-reviews-migration.mjs
//
// Idempotent — safe to re-run (`CREATE TABLE IF NOT EXISTS`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from '@vercel/postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, 'create_google_reviews.sql'),
  'utf8'
);

const STATEMENTS = migrationSql
  .split(';')
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter((s) => s.length > 0);

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log('\n✓ google_reviews table migration applied.');
