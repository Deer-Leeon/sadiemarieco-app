// One-shot (idempotent) setup of the recurring QStash schedules that keep
// production self-healing and monitored:
//
//   0 0 * * *  America/Denver  → /api/cron/cleanup-abandoned  (midnight MT)
//   0 * * * *  America/Denver  → /api/cron/health-alert       (hourly, MT)
//   0 6 * * *  America/Denver  → /api/cron/sync-reviews       (6am MT)
//   */15 * * * *                 → /api/cron/ensure-reminders  (SMS reminder backfill)
//
// Existing schedules for the same destination are replaced, so re-running
// is safe. Vercel Cron (vercel.json) keeps daily/hourly backstops in UTC
// for the first two in case QStash itself has an outage.
//
// Usage:
//   node --env-file=.env.local scripts/setup-qstash-schedules.mjs

const BASE = 'https://www.sadiemarie.co';

const QSTASH_URL = (
  process.env.QSTASH_URL?.trim() || 'https://qstash-us-east-1.upstash.io'
).replace(/\/$/, '');
const QSTASH_TOKEN = process.env.QSTASH_TOKEN?.trim();
const CRON_SECRET = process.env.CRON_SECRET?.trim();

if (!QSTASH_TOKEN || !CRON_SECRET) {
  console.error('QSTASH_TOKEN and CRON_SECRET are required (use --env-file=.env.local)');
  process.exit(1);
}

const wanted = [
  {
    destination: `${BASE}/api/cron/cleanup-abandoned`,
    cron: 'CRON_TZ=America/Denver 0 0 * * *',
  },
  {
    destination: `${BASE}/api/cron/health-alert`,
    cron: 'CRON_TZ=America/Denver 0 * * * *',
  },
  {
    destination: `${BASE}/api/cron/sync-reviews`,
    cron: 'CRON_TZ=America/Denver 0 6 * * *',
  },
  {
    destination: `${BASE}/api/cron/ensure-reminders`,
    cron: '*/15 * * * *',
  },
];

async function api(path, init = {}) {
  const res = await fetch(`${QSTASH_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json().catch(() => null);
}

const existing = (await api('/v2/schedules')) || [];
console.log(`Found ${existing.length} existing schedule(s).`);

for (const { destination, cron } of wanted) {
  // Replace any existing schedule(s) for the destination (idempotency).
  const dupes = existing.filter(
    (s) => (s.destination || '').replace(/\/$/, '') === destination
  );
  for (const dupe of dupes) {
    await api(`/v2/schedules/${dupe.scheduleId}`, { method: 'DELETE' });
    console.log(`  deleted old schedule ${dupe.scheduleId} for ${destination}`);
  }

  // QStash expects the raw destination URL in the path (not URL-encoded).
  const created = await api(
    `/v2/schedules/${destination}`,
    {
      method: 'POST',
      headers: {
        'Upstash-Cron': cron,
        'Upstash-Method': 'GET',
        'Upstash-Retries': '3',
        // Forwarded to the destination as X-Cron-Secret (lib/cron-auth.ts).
        'Upstash-Forward-X-Cron-Secret': CRON_SECRET,
      },
    }
  );
  console.log(`✓ ${cron}  ${destination}  (${created?.scheduleId ?? 'created'})`);
}

console.log('\nAll QStash schedules in place.');
