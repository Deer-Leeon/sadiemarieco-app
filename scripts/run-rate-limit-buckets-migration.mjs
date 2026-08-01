// Usage:
//   node --env-file=.env.local scripts/run-rate-limit-buckets-migration.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '@vercel/postgres';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'rate-limit-buckets.sql'), 'utf8');

// Neon serverless accepts one statement per query.
const statements = raw
  .split(/;\s*\n/)
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);

for (const statement of statements) {
  await sql.query(statement.endsWith(';') ? statement : `${statement};`);
}

console.log('✓ rate_limit_buckets migration applied.');
