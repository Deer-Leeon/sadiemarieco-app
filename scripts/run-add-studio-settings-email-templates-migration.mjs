// Usage:
//   node --env-file=.env.local scripts/run-add-studio-settings-email-templates-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE studio_settings
    ADD COLUMN IF NOT EXISTS email_templates JSONB NOT NULL DEFAULT '{}'::jsonb
`);

console.log('✓ studio_settings.email_templates migration applied.');
