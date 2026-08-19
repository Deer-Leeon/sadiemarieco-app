// Usage:
//   node --env-file=.env.local scripts/run-ops-state-migration.mjs
import { sql } from '@vercel/postgres';

const statements = [
  `CREATE TABLE IF NOT EXISTS ops_state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

console.log(`Applying ${statements.length} statements…\n`);

for (const [i, statement] of statements.entries()) {
  process.stdout.write(`[${i + 1}/${statements.length}] `);
  try {
    await sql.query(statement);
    console.log('ok');
  } catch (err) {
    console.error('FAILED');
    console.error(statement);
    console.error(err);
    process.exit(1);
  }
}

console.log('\n✓ ops_state migration applied.');
process.exit(0);
