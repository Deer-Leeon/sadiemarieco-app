// Usage:
//   node --env-file=.env.local scripts/run-sms-outbound-log-migration.mjs
import { sql } from '@vercel/postgres';

const statements = [
  `CREATE TABLE IF NOT EXISTS sms_outbound_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    template_key TEXT NOT NULL,
    body TEXT NOT NULL,
    to_e164 TEXT NOT NULL,
    client_id UUID,
    client_name TEXT,
    booking_uid TEXT,
    twilio_sid TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sms_outbound_log_created_at_idx
    ON sms_outbound_log (created_at DESC)`,
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

console.log('\n✓ sms_outbound_log migration applied.');
process.exit(0);
