// One-shot runner for the appointments.check_status amendment that
// adds 'canceled_by_system' to the allowed values.
//
// Usage:
//   node --env-file=.env.local scripts/run-canceled-by-system-migration.mjs
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
       'canceled_by_client',
       'canceled_by_system'
     ))`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log("\n✓ appointments.check_status now allows 'canceled_by_system'.");
