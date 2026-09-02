// Usage:
//   node --env-file=.env.local scripts/run-sms-outbound-log-client-indexes-migration.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '@vercel/postgres';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'sms-outbound-log-client-indexes.sql'), 'utf8');

const statements = raw
  .split(/;\s*\n/)
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);

console.log(`Applying ${statements.length} statements…\n`);

for (const [i, statement] of statements.entries()) {
  process.stdout.write(`[${i + 1}/${statements.length}] `);
  try {
    await sql.query(statement.endsWith(';') ? statement : `${statement};`);
    console.log('ok');
  } catch (err) {
    console.error('FAILED');
    console.error(statement);
    console.error(err);
    process.exit(1);
  }
}

console.log('\n✓ sms_outbound_log client indexes migration applied.');
process.exit(0);
