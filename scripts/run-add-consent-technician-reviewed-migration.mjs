// Usage:
//   node --env-file=.env.local scripts/run-add-consent-technician-reviewed-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS consent_technician_reviewed_at TIMESTAMPTZ
`);

await sql.query(`
  COMMENT ON COLUMN clients.consent_technician_reviewed_at IS
    'When an admin stamped Reviewed by Technician onto the signed consent PDF.'
`);

console.log('✓ clients.consent_technician_reviewed_at migration applied.');
