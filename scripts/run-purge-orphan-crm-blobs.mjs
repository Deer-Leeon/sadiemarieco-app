/**
 * Delete Vercel Blob objects left behind after a CRM purge.
 *
 * Only removes CRM paths:
 *   - client-photos/**
 *   - client-consents/**
 *
 * Never touches:
 *   - site-images/**          (website CMS)
 *   - studio-settings/**      (consent PDF template)
 *
 * Dry run (list only):
 *   node --env-file=.env.local scripts/run-purge-orphan-crm-blobs.mjs
 *
 * Destructive:
 *   PURGE_ORPHAN_CRM_BLOBS=YES node --env-file=.env.local scripts/run-purge-orphan-crm-blobs.mjs
 */
import { del, list } from '@vercel/blob';

const PURGE_PREFIXES = ['client-photos/', 'client-consents/'];
const KEEP_PREFIXES = ['site-images/', 'studio-settings/'];

const confirmed = process.env.PURGE_ORPHAN_CRM_BLOBS === 'YES';
const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();

if (!token) {
  console.error('Missing BLOB_READ_WRITE_TOKEN');
  process.exit(1);
}

async function listAll(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({
      prefix,
      limit: 1000,
      cursor,
      token,
    });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

console.log(
  confirmed
    ? '\n⚠️  PURGE mode — deleting CRM Blob orphans only\n'
    : '\nDry run — listing only (set PURGE_ORPHAN_CRM_BLOBS=YES to delete)\n'
);

const toDelete = [];
for (const prefix of PURGE_PREFIXES) {
  const blobs = await listAll(prefix);
  const bytes = blobs.reduce((sum, b) => sum + (b.size || 0), 0);
  console.log(`Will purge ${prefix}: ${blobs.length} files (${formatBytes(bytes)})`);
  toDelete.push(...blobs);
}

console.log('\nWill keep:');
for (const prefix of KEEP_PREFIXES) {
  const blobs = await listAll(prefix);
  const bytes = blobs.reduce((sum, b) => sum + (b.size || 0), 0);
  console.log(`  ${prefix.padEnd(20)} ${blobs.length} files (${formatBytes(bytes)})`);
}

if (!confirmed) {
  console.log(
    `\nNo blobs deleted. Re-run with PURGE_ORPHAN_CRM_BLOBS=YES to purge ${toDelete.length} files.`
  );
  process.exit(0);
}

if (toDelete.length === 0) {
  console.log('\nNothing to delete.');
  process.exit(0);
}

console.log(`\n→ Deleting ${toDelete.length} blobs…`);
const urls = toDelete.map((b) => b.url);
const BATCH = 100;
let deleted = 0;
for (let i = 0; i < urls.length; i += BATCH) {
  const batch = urls.slice(i, i + BATCH);
  await del(batch, { token });
  deleted += batch.length;
  console.log(`  deleted ${deleted}/${urls.length}`);
}

console.log('\n✓ CRM Blob orphans purged.');
console.log('\nAfter purge:');
for (const prefix of PURGE_PREFIXES) {
  const blobs = await listAll(prefix);
  console.log(`  ${prefix.padEnd(20)} ${blobs.length}`);
}
console.log('Still present:');
for (const prefix of KEEP_PREFIXES) {
  const blobs = await listAll(prefix);
  console.log(`  ${prefix.padEnd(20)} ${blobs.length}`);
}
