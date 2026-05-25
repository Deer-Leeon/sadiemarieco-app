// One-shot runner for the appointments.check_status amendment that
// adds 'pending' to the allowed values.
//
// Usage:
//   node --env-file=.env.local scripts/run-pending-status-migration.mjs
//
// Uses @vercel/postgres (the same client our app uses). The Neon
// serverless driver only accepts one statement per query, so we split
// the migration into discrete statements here rather than feeding the
// whole .sql file as one blob.
//
// Idempotent — safe to re-run. The DROP uses IF EXISTS and the ADD
// is a strict superset of the prior value set, so existing rows can
// never become non-conforming on re-application.
import { sql } from '@vercel/postgres';

const STATEMENTS = [
  `ALTER TABLE appointments
     DROP CONSTRAINT IF EXISTS check_status`,

  `ALTER TABLE appointments
     ADD CONSTRAINT check_status
     CHECK (status IN (
       'pending',
       'confirmed',
       'no-show',
       'canceled_by_admin',
       'canceled_by_client'
     ))`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log("\n✓ appointments.check_status now allows 'pending'.");
