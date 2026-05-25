// One-shot runner for switching appointments.status DEFAULT from
// 'confirmed' to 'pending'.
//
// Usage:
//   node --env-file=.env.local scripts/run-change-status-default.mjs
//
// Metadata-only change — does not touch existing rows. Idempotent;
// re-running is a no-op.
import { sql } from '@vercel/postgres';

const STATEMENTS = [
  `ALTER TABLE appointments
     ALTER COLUMN status SET DEFAULT 'pending'`,
];

for (const stmt of STATEMENTS) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
  process.stdout.write(`→ ${preview}…\n`);
  await sql.query(stmt);
}

console.log("\n✓ appointments.status default is now 'pending'.");
