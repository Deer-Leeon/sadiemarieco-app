// Usage:
//   node --env-file=.env.local scripts/run-admin-push-deliveries-migration.mjs
//
// Idempotent (IF NOT EXISTS everywhere). The sender also creates these
// tables lazily, so running this is only needed to pre-create them.
import { sql } from '@vercel/postgres';

const statements = [
  `CREATE TABLE IF NOT EXISTS admin_push_deliveries (
    id BIGSERIAL PRIMARY KEY,
    booking_uid TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL,
    detail TEXT,
    apns_status INTEGER,
    apns_reason TEXT,
    apns_id TEXT,
    token_prefix TEXT,
    bundle_id TEXT,
    environment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS admin_push_deliveries_booking_uid_idx
    ON admin_push_deliveries (booking_uid)`,
  `CREATE INDEX IF NOT EXISTS admin_push_deliveries_created_at_idx
    ON admin_push_deliveries (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS admin_push_provider_token (
    key_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

for (const statement of statements) {
  await sql.query(statement);
}

console.log('✓ admin_push_deliveries + admin_push_provider_token migration applied.');
