/**
 * Purge all booking / CRM client data from Postgres.
 *
 * Usage (preview counts only):
 *   node --env-file=.env.local scripts/run-purge-booking-data.mjs
 *
 * Usage (destructive — requires explicit confirmation):
 *   PURGE_BOOKING_DATA=YES node --env-file=.env.local scripts/run-purge-booking-data.mjs
 *
 * Preserves: site_services, site_images, studio_settings, google_reviews
 * Does not delete Vercel Blob files (client photos, stamped consent PDFs).
 */
import { sql } from '@vercel/postgres';

const TABLES = [
  'clients',
  'appointments',
  'webhook_events',
  'client_photos',
  'client_notes',
  'client_intake_forms',
];

function maskDbUrl(url) {
  if (!url || typeof url !== 'string') return '[unknown]';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\//, '').split('/')[0] || 'db'}`;
  } catch {
    return '[redacted]';
  }
}

async function countTable(table) {
  const { rows } = await sql.query(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return rows[0]?.count ?? '?';
}

const confirmed = process.env.PURGE_BOOKING_DATA === 'YES';

console.log(`Database: ${maskDbUrl(process.env.POSTGRES_URL)}`);
console.log(confirmed ? '\n⚠️  PURGE mode — deleting booking data\n' : '\nDry run — row counts only (set PURGE_BOOKING_DATA=YES to delete)\n');

for (const table of TABLES) {
  const count = await countTable(table);
  console.log(`  ${table.padEnd(22)} ${count}`);
}

if (!confirmed) {
  console.log('\nNo rows deleted. Re-run with PURGE_BOOKING_DATA=YES to purge.');
  process.exit(0);
}

console.log('\n→ TRUNCATE booking tables…');
await sql.query(`
  TRUNCATE TABLE
    webhook_events,
    appointments,
    client_photos,
    client_notes,
    client_intake_forms,
    clients
  RESTART IDENTITY CASCADE
`);

console.log('\n✓ Booking data purged. Preserved: site_services, site_images, studio_settings, google_reviews.');
console.log('  Note: Vercel Blob files for client photos / consent PDFs were not removed from storage.');

for (const table of TABLES) {
  const count = await countTable(table);
  console.log(`  ${table.padEnd(22)} ${count}`);
}
