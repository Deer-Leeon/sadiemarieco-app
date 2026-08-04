/**
 * Cancel all non-cancelled Cal.com bookings (upcoming + past accepted/pending).
 * Staging and production share one Cal calendar — run once.
 *
 * Dry run:
 *   node --env-file=.env.local scripts/run-cancel-all-cal-bookings.mjs
 *
 * Destructive:
 *   CANCEL_ALL_CAL_BOOKINGS=YES node --env-file=.env.local scripts/run-cancel-all-cal-bookings.mjs
 */
const CAL_V2_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
const REASON = 'Test data purge before production launch';

const TERMINAL = new Set(['cancelled', 'canceled', 'rejected']);

function getApiKey() {
  const key =
    process.env.CAL_API_KEY?.trim() || process.env.CALCOM_API_KEY?.trim();
  if (!key) {
    console.error('Missing CAL_API_KEY / CALCOM_API_KEY');
    process.exit(1);
  }
  return key;
}

async function fetchStatus(apiKey, status) {
  const bookings = [];
  let page = 1;
  while (page <= 20) {
    const url = new URL(`${CAL_V2_BASE}/bookings`);
    url.searchParams.set('take', '100');
    url.searchParams.set('status', status);
    url.searchParams.set('page', String(page));
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `List ${status} failed HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`
      );
    }
    const rows = Array.isArray(body.data) ? body.data : [];
    bookings.push(...rows);
    const hasNext = Boolean(body.pagination?.hasNextPage);
    if (!rows.length || !hasNext) break;
    page += 1;
  }
  return bookings;
}

async function cancelBooking(apiKey, uid) {
  const res = await fetch(
    `${CAL_V2_BASE}/bookings/${encodeURIComponent(uid)}/cancel`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cancellationReason: REASON }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body && (body.message || body.error)) ||
      JSON.stringify(body).slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

const confirmed = process.env.CANCEL_ALL_CAL_BOOKINGS === 'YES';
const apiKey = getApiKey();

console.log(
  confirmed
    ? '\n⚠️  CANCEL mode — cancelling all active Cal.com bookings\n'
    : '\nDry run — listing active bookings (set CANCEL_ALL_CAL_BOOKINGS=YES to cancel)\n'
);

const upcoming = await fetchStatus(apiKey, 'upcoming');
const past = await fetchStatus(apiKey, 'past');
const unconfirmed = await fetchStatus(apiKey, 'unconfirmed');

const seen = new Set();
const active = [];
for (const b of [...upcoming, ...past, ...unconfirmed]) {
  const uid = typeof b?.uid === 'string' ? b.uid.trim() : '';
  if (!uid || seen.has(uid)) continue;
  const status = String(b.status || '').toLowerCase();
  if (TERMINAL.has(status)) continue;
  seen.add(uid);
  active.push({
    uid,
    status,
    start: b.start,
    title: String(b.title || '').slice(0, 80),
  });
}

console.log(`Active bookings to cancel: ${active.length}`);
for (const b of active) {
  console.log(`  [${b.status}] ${b.start}  ${b.title}  (${b.uid})`);
}

if (!confirmed) {
  console.log('\nNo bookings cancelled.');
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const b of active) {
  try {
    await cancelBooking(apiKey, b.uid);
    ok += 1;
    console.log(`  ✓ cancelled ${b.uid}`);
  } catch (err) {
    fail += 1;
    console.error(`  ✗ ${b.uid}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\nDone. Cancelled ${ok}, failed ${fail}.`);
if (fail > 0) process.exit(1);
