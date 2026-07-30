// Usage:
//   node --env-file=.env.local scripts/run-add-studio-settings-staging-sms-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE studio_settings
    ADD COLUMN IF NOT EXISTS staging_outbound_sms_enabled BOOLEAN NOT NULL DEFAULT false
`);

console.log('✓ studio_settings.staging_outbound_sms_enabled migration applied.');
