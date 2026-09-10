// Read-only report: did every confirmed / rescheduled / canceled appointment
// produce an admin iOS push, and what did Apple answer?
//
//   node --env-file=.env.local scripts/admin-push-audit.mjs            # last 14 days
//   SINCE_DAYS=30 node --env-file=.env.local scripts/admin-push-audit.mjs
//   UID=abc123 node --env-file=.env.local scripts/admin-push-audit.mjs  # one booking
//
// Prints booking UIDs, statuses, timestamps and APNs codes only — no client
// names or phone numbers.
import { sql } from '@vercel/postgres';

const sinceDays = Number(process.env.SINCE_DAYS || 14);
const onlyUid = (process.env.UID || '').trim();

function ts(value) {
  return value instanceof Date ? value.toISOString().slice(0, 16) : String(value ?? '').slice(0, 16);
}

const { rows: devices } = await sql`
  SELECT left(device_token, 8) AS tok, bundle_id, environment, updated_at, email
  FROM admin_push_devices ORDER BY updated_at DESC`;
console.log('== registered admin devices');
if (devices.length === 0) console.log('  (none — no phone can be alerted)');
for (const d of devices) {
  const email = String(d.email).replace(/^(.{3}).*(@.*)$/, '$1…$2');
  console.log(`  ${d.tok}…  ${d.bundle_id.padEnd(36)} ${d.environment.padEnd(12)} seen ${ts(d.updated_at)}  ${email}`);
}

const { rows: jwt } = await sql`
  SELECT key_id, issued_at FROM admin_push_provider_token`;
console.log('\n== shared APNs provider token');
if (jwt.length === 0) console.log('  (not minted yet)');
for (const j of jwt) console.log(`  key ${j.key_id}  issued ${ts(j.issued_at)}`);

if (onlyUid) {
  const { rows } = await sql`
    SELECT created_at, kind, source, attempt, outcome, detail, apns_status, apns_reason, token_prefix, bundle_id, environment
    FROM admin_push_deliveries WHERE booking_uid = ${onlyUid} ORDER BY created_at`;
  console.log(`\n== delivery log for ${onlyUid} (${rows.length} rows)`);
  for (const r of rows) {
    console.log(
      `  ${ts(r.created_at)}  ${r.kind.padEnd(11)} ${r.source.padEnd(6)} #${r.attempt} ${r.outcome.padEnd(15)} ` +
        `${r.apns_status ?? ''} ${r.apns_reason ?? ''} ${r.token_prefix ? r.token_prefix + '…' : ''} ${r.detail ?? ''}`.trimEnd()
    );
  }
  process.exit(0);
}

const { rows: appts } = await sql.query(
  `SELECT cal_event_id, status, booking_time, created_at
   FROM appointments
   WHERE created_at >= now() - ($1 || ' days')::interval
     AND attached_to_appointment_id IS NULL
   ORDER BY created_at DESC`,
  [String(sinceDays)]
);

const { rows: claims } = await sql`
  SELECT booking_uid FROM webhook_events WHERE booking_uid LIKE '%:admin_push%'`;
const claimSet = new Set(claims.map((c) => c.booking_uid));

const { rows: deliveries } = await sql.query(
  `SELECT booking_uid, kind, outcome, apns_status, apns_reason, attempt
   FROM admin_push_deliveries
   WHERE created_at >= now() - ($1 || ' days')::interval`,
  [String(sinceDays)]
);
const byUid = new Map();
for (const d of deliveries) {
  const key = `${d.booking_uid}|${d.kind}`;
  if (!byUid.has(key)) byUid.set(key, []);
  byUid.get(key).push(d);
}

function summarize(uid, kind) {
  const rows = byUid.get(`${uid}|${kind}`) || [];
  if (rows.length === 0) return claimSet.has(kind === 'confirmed' ? `${uid}:admin_push` : `${uid}:admin_push:${kind}`) ? 'claimed(no log)' : '';
  const sent = rows.filter((r) => r.outcome === 'sent').length;
  if (sent > 0) return `sent×${sent}`;
  const last = rows[rows.length - 1];
  return `${last.outcome}${last.apns_status ? ' ' + last.apns_status : ''}${last.apns_reason ? ' ' + last.apns_reason : ''}`;
}

const CANCELED = new Set(['canceled_by_client', 'canceled_by_client_late', 'canceled_by_admin']);
const CONFIRMED_LIKE = new Set(['confirmed', 'completed', 'no-show', ...CANCELED]);

console.log(`\n== appointments created in the last ${sinceDays} days: ${appts.length}`);
console.log('   (rescheduled bookings get a new UID; their "confirmed" alert lives on the old UID)');
let problems = 0;
for (const a of appts) {
  const uid = String(a.cal_event_id || '');
  const st = String(a.status || '');
  const flags = [];
  if (!uid) {
    if (CONFIRMED_LIKE.has(st)) flags.push('NO_CAL_UID → cannot alert');
  } else {
    const c = summarize(uid, 'confirmed');
    const r = summarize(uid, 'rescheduled');
    const x = summarize(uid, 'canceled');
    if (CONFIRMED_LIKE.has(st) && !c && !r) flags.push('no confirmed/rescheduled alert');
    if (CANCELED.has(st) && !x) flags.push('no cancel alert');
    for (const [label, s] of [['confirmed', c], ['rescheduled', r], ['canceled', x]]) {
      if (s && !s.startsWith('sent') && s !== 'claimed(no log)') flags.push(`${label}: ${s}`);
    }
    if (flags.length) problems += 1;
    console.log(`  ${ts(a.created_at)}  ${uid.padEnd(24)} ${st.padEnd(24)} ${[c && `C:${c}`, r && `R:${r}`, x && `X:${x}`].filter(Boolean).join('  ').padEnd(40)} ${flags.join('; ')}`);
    continue;
  }
  if (flags.length) problems += 1;
  console.log(`  ${ts(a.created_at)}  ${'(no uid)'.padEnd(24)} ${st.padEnd(24)} ${''.padEnd(40)} ${flags.join('; ')}`);
}
console.log(`\n${problems} appointment(s) flagged.`);

const { rows: outcomes } = await sql.query(
  `SELECT outcome, apns_status, apns_reason, count(*)::int AS n
   FROM admin_push_deliveries
   WHERE created_at >= now() - ($1 || ' days')::interval
   GROUP BY 1, 2, 3 ORDER BY n DESC`,
  [String(sinceDays)]
);
console.log('\n== APNs outcomes');
if (outcomes.length === 0) console.log('  (no delivery rows yet — table fills from the next alert onward)');
for (const o of outcomes) console.log(`  ${String(o.n).padStart(5)}  ${o.outcome.padEnd(16)} ${o.apns_status ?? ''} ${o.apns_reason ?? ''}`);
