/**
 * Admin iOS APNs: register table helpers, send on booking lifecycle
 * (confirmed / rescheduled / canceled), QStash retry.
 *
 * Never throws to callers of notifyAdminAppointmentPush — checkout,
 * reschedule, and cancel must succeed even if Apple is down.
 *
 * Delivery guarantees (see docs/admin-ios-push.md):
 *  - Every attempt and every skip is written to `admin_push_deliveries`
 *    with Apple's status/reason, so a missing banner is diagnosable after
 *    Vercel's ~1h log window has closed.
 *  - The ES256 provider JWT is shared through Postgres
 *    (`admin_push_provider_token`). Apple returns 429
 *    TooManyProviderTokenUpdates when a key mints tokens more than once per
 *    20 minutes; per-instance caches cannot honour that on serverless.
 *  - A 403 ExpiredProviderToken / InvalidProviderToken re-signs once and
 *    retries in the same request instead of dropping the alert.
 *  - Anything else that is not a hard 4xx is retried through QStash with
 *    growing delays (15s → 60s → 5m → 15m → 1h). Leftover tokens after a
 *    partially successful retry are re-queued, not dropped.
 *  - If nothing landed and nothing is queued, the dedupe claim is released
 *    so the next lifecycle path (Cal webhook after checkout, etc.) can send.
 */

const crypto = require('crypto');
const http2 = require('http2');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');
const { isStagingDeployment } = require('./outbound-sms-allowed');

const TOKEN_RE = /^[A-Fa-f0-9]{64,200}$/;
const DEDUPE_SUFFIX = ':admin_push';
const PUSH_KINDS = new Set(['confirmed', 'rescheduled', 'canceled']);
/** Reuse a provider JWT for 50 min (Apple accepts up to 60). */
const JWT_TTL_SEC = 50 * 60;
/** Keep undelivered alerts on APNs for a week (UNIX timestamp). */
const APNS_STORE_SEC = 7 * 24 * 60 * 60;
const APNS_TIMEOUT_MS = 8000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';
const DEFAULT_QSTASH_URL = 'https://qstash-us-east-1.upstash.io';

/** Attempt 1 is the inline send; attempts 2..MAX run via QStash. */
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_SEC = [15, 60, 300, 900, 3600];

const ALLOWED_BUNDLE_IDS = new Set([
  'com.lj-buchmiller.SadieMarie',
  'com.lj-buchmiller.SadieMarie.dev',
]);

let tableEnsured = false;
let logTablesEnsured = false;
let cachedJwt = { token: '', issuedAt: 0 };

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Cal.com webhooks target production (`www`), not staging. A staging admin
 * booking still creates a real Cal event, so production already sends the
 * iOS alert. Staging must not send a second one (SMS is gated the same way).
 */
function headerHost(value) {
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim().split(':')[0].toLowerCase();
}

function isProductionPublicHost(requestHost) {
  const host = headerHost(requestHost);
  return host === 'www.sadiemarie.co' || host === 'sadiemarie.co';
}

function shouldSendAdminPush(requestHost) {
  // Runtime Host is the only signal that survives a Preview→Production
  // promote (APP_ENV / VERCEL_GIT_COMMIT_REF / VERCEL_ENV are inlined at
  // build time from the staging branch). Cal webhooks and /manage cancel
  // hit www — those must always alert.
  if (isProductionPublicHost(requestHost)) return true;
  if (process.env.VERCEL_ENV === 'production') return true;
  if (isStagingDeployment()) return false;
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== 'production') return false;
  return true;
}

function normalizeKind(kind) {
  const k = String(kind || 'confirmed').toLowerCase();
  return PUSH_KINDS.has(k) ? k : 'confirmed';
}

function normalizeSource(source) {
  return source === 'admin' ? 'admin' : 'client';
}

function normalizeAttempt(attempt) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_ATTEMPTS + 1);
}

function retryDelaySec(nextAttempt) {
  // nextAttempt is 2-based (attempt 1 was inline).
  const idx = Math.max(0, Math.min(RETRY_DELAYS_SEC.length - 1, nextAttempt - 2));
  return RETRY_DELAYS_SEC[idx];
}

function adminPushDedupeKey(bookingUid, kind) {
  const uid = String(bookingUid || '').trim();
  const k = normalizeKind(kind);
  // Confirmed keeps the original key so in-flight retries after deploy
  // still dedupe against alerts already claimed as `{uid}:admin_push`.
  if (k === 'confirmed') return `${uid}${DEDUPE_SUFFIX}`;
  return `${uid}${DEDUPE_SUFFIX}:${k}`;
}

async function ensureAdminPushDevicesTable() {
  if (tableEnsured) return;
  await sql.query(`
    CREATE TABLE IF NOT EXISTS admin_push_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      device_token TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_push_devices_token_uniq UNIQUE (device_token),
      CONSTRAINT admin_push_devices_environment_chk
        CHECK (environment IN ('development', 'production')),
      CONSTRAINT admin_push_devices_token_format_chk
        CHECK (device_token ~ '^[A-Fa-f0-9]{64,200}$')
    )
  `);
  tableEnsured = true;
}

async function ensureLogTables() {
  if (logTablesEnsured) return;
  await sql.query(`
    CREATE TABLE IF NOT EXISTS admin_push_deliveries (
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
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS admin_push_deliveries_booking_uid_idx
      ON admin_push_deliveries (booking_uid)
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS admin_push_provider_token (
      key_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logTablesEnsured = true;
}

/**
 * Append one row to admin_push_deliveries. Never throws.
 *
 * outcome: 'sent' | 'skipped' | 'invalid_token' | 'retryable' |
 *          'retry_scheduled' | 'rejected' | 'error' | 'exhausted'
 */
async function logDelivery({
  bookingUid,
  kind,
  source,
  attempt = 1,
  outcome,
  detail = null,
  apnsStatus = null,
  apnsReason = null,
  apnsId = null,
  tokenPrefix = null,
  bundleId = null,
  environment = null,
}) {
  try {
    await ensureLogTables();
    await sql`
      INSERT INTO admin_push_deliveries (
        booking_uid, kind, source, attempt, outcome, detail,
        apns_status, apns_reason, apns_id, token_prefix, bundle_id, environment
      ) VALUES (
        ${String(bookingUid || '').slice(0, 200)},
        ${normalizeKind(kind)},
        ${normalizeSource(source)},
        ${normalizeAttempt(attempt)},
        ${String(outcome || 'error').slice(0, 40)},
        ${detail == null ? null : String(detail).slice(0, 500)},
        ${apnsStatus == null ? null : Number(apnsStatus) || 0},
        ${apnsReason == null ? null : String(apnsReason).slice(0, 120)},
        ${apnsId == null ? null : String(apnsId).slice(0, 80)},
        ${tokenPrefix == null ? null : String(tokenPrefix).slice(0, 12)},
        ${bundleId == null ? null : String(bundleId).slice(0, 80)},
        ${environment == null ? null : String(environment).slice(0, 20)}
      )
    `;
  } catch (err) {
    console.warn('[admin-booking-push] delivery log write failed', {
      outcome,
      error: errorMessage(err),
    });
  }
}

function tokenPrefix(token) {
  return String(token || '').slice(0, 8);
}

function serviceLabel(serviceName) {
  const raw = typeof serviceName === 'string' ? serviceName : '';
  return raw.split(' between ')[0]?.trim() || 'appointment';
}

function formatDenverTime(iso) {
  if (!iso) return '';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizePem(raw) {
  const trimmed = String(raw || '').trim().replace(/\\n/g, '\n');
  if (!trimmed) return '';
  if (trimmed.includes('BEGIN PRIVATE KEY')) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
}

function apnsCredentials() {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const pem = normalizePem(process.env.APNS_P8);
  if (!keyId || !teamId || !pem) return null;
  return { keyId, teamId, pem };
}

function signProviderJwt({ keyId, teamId, pem }) {
  const iat = nowSec();
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId }),
    'utf8'
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: teamId, iat }),
    'utf8'
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto
    .createSign('SHA256')
    .update(unsigned)
    .sign({ key: pem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return { token: `${unsigned}.${signature}`, iat };
}

function jwtIsFresh(issuedAtSec) {
  return issuedAtSec > 0 && nowSec() - issuedAtSec < JWT_TTL_SEC;
}

function toEpochSec(value) {
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * Provider JWT shared across serverless instances via Postgres.
 *
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<{ ok: true, token: string } | { ok: false, error: string }>}
 */
async function apnsJwt(opts = {}) {
  const creds = apnsCredentials();
  if (!creds) return { ok: false, error: 'apns_not_configured' };

  if (!opts.forceRefresh && cachedJwt.token && jwtIsFresh(cachedJwt.issuedAt)) {
    return { ok: true, token: cachedJwt.token };
  }

  try {
    await ensureLogTables();

    if (!opts.forceRefresh) {
      const { rows } = await sql`
        SELECT token, issued_at FROM admin_push_provider_token
        WHERE key_id = ${creds.keyId}
        LIMIT 1
      `;
      const row = rows[0];
      if (row && jwtIsFresh(toEpochSec(row.issued_at))) {
        cachedJwt = { token: row.token, issuedAt: toEpochSec(row.issued_at) };
        return { ok: true, token: row.token };
      }
    }

    const minted = signProviderJwt(creds);
    // Apple rejects keys that mint more than one token per 20 minutes, so
    // only one instance wins the refresh inside that window; the others read
    // back the winner's token. On forceRefresh (Apple said the stored token
    // is bad) always overwrite.
    const { rows: written } = opts.forceRefresh
      ? await sql`
          INSERT INTO admin_push_provider_token (key_id, token, issued_at)
          VALUES (${creds.keyId}, ${minted.token}, NOW())
          ON CONFLICT (key_id) DO UPDATE SET
            token = EXCLUDED.token,
            issued_at = NOW()
          RETURNING token, issued_at
        `
      : await sql`
          INSERT INTO admin_push_provider_token (key_id, token, issued_at)
          VALUES (${creds.keyId}, ${minted.token}, NOW())
          ON CONFLICT (key_id) DO UPDATE SET
            token = EXCLUDED.token,
            issued_at = NOW()
          WHERE admin_push_provider_token.issued_at < NOW() - INTERVAL '20 minutes'
          RETURNING token, issued_at
        `;
    if (written.length > 0) {
      cachedJwt = { token: written[0].token, issuedAt: toEpochSec(written[0].issued_at) };
      return { ok: true, token: written[0].token };
    }

    // Someone else refreshed within the last 20 minutes — use theirs even if
    // it is close to expiry; it is still younger than 60 min.
    const { rows: latest } = await sql`
      SELECT token, issued_at FROM admin_push_provider_token
      WHERE key_id = ${creds.keyId}
      LIMIT 1
    `;
    if (latest[0]) {
      cachedJwt = { token: latest[0].token, issuedAt: toEpochSec(latest[0].issued_at) };
      return { ok: true, token: latest[0].token };
    }
    cachedJwt = { token: minted.token, issuedAt: minted.iat };
    return { ok: true, token: minted.token };
  } catch (err) {
    // Postgres hiccup: fall back to a per-instance token rather than
    // dropping the alert. Signing failures surface as apns_jwt_sign_failed.
    try {
      const minted = signProviderJwt(creds);
      cachedJwt = { token: minted.token, issuedAt: minted.iat };
      console.warn('[admin-booking-push] shared JWT unavailable — using local token', {
        error: errorMessage(err),
      });
      return { ok: true, token: minted.token };
    } catch (signErr) {
      return { ok: false, error: `apns_jwt_sign_failed: ${errorMessage(signErr)}` };
    }
  }
}

function apnsExpirationUnix() {
  return nowSec() + APNS_STORE_SEC;
}

function collapseId(payload) {
  const uid =
    payload && typeof payload.bookingUid === 'string'
      ? payload.bookingUid.trim()
      : '';
  if (!uid) return '';
  const kind = normalizeKind(payload && payload.kind);
  return `${uid}:${kind}`.slice(0, 64);
}

function displayWho(clientName, { capitalize } = {}) {
  const who = typeof clientName === 'string' ? clientName.trim() : '';
  if (who) return who;
  return capitalize ? 'A client' : 'a client';
}

function withWhen(text, when) {
  return when ? `${text} · ${when}` : text;
}

function apnsHost(environment) {
  return environment === 'development'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
}

function isInvalidTokenStatus(status, reason) {
  if (status === 410) return true;
  const r = String(reason || '').toLowerCase();
  return (
    r === 'baddevicetoken' ||
    r === 'unregistered' ||
    r === 'deviceunregistered' ||
    // Token belongs to a different bundle id than the row claims — the app
    // re-registers with the right one on next foreground.
    r === 'devicetokennotfortopic'
  );
}

function isProviderTokenStatus(status, reason) {
  const r = String(reason || '').toLowerCase();
  return (
    status === 403 &&
    (r === 'expiredprovidertoken' ||
      r === 'invalidprovidertoken' ||
      r === 'missingprovidertoken')
  );
}

function isRetryableStatus(status, reason) {
  if (status === 0) return true; // connect error / timeout
  if (status === 429) return true; // TooManyRequests / TooManyProviderTokenUpdates
  if (status >= 500) return true;
  // Apple occasionally answers 403/400 with transient reasons.
  const r = String(reason || '').toLowerCase();
  return r === 'internalservererror' || r === 'serviceunavailable' || r === 'shutdown';
}

/**
 * @returns {Promise<{ status: number, reason: string | null, apnsId: string | null }>}
 */
function postApns({ token, jwt, bundleId, payload, environment }) {
  const host = apnsHost(environment);
  const path = `/3/device/${token}`;
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    let settled = false;
    let client;
    const closeClient = () => {
      try {
        if (client) client.close();
      } catch {
        /* ignore */
      }
    };
    const finish = (status, reason, apnsId = null) => {
      if (settled) return;
      settled = true;
      closeClient();
      resolve({ status, reason, apnsId });
    };

    try {
      client = http2.connect(host);
    } catch (err) {
      finish(0, errorMessage(err));
      return;
    }

    const timer = setTimeout(() => finish(0, 'timeout'), APNS_TIMEOUT_MS);

    client.on('error', (err) => {
      clearTimeout(timer);
      finish(0, errorMessage(err));
    });

    const headers = {
      ':method': 'POST',
      ':path': path,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // Store on APNs so a brief offline window still delivers
      // (expiration 0 discards immediately if the device is unreachable).
      'apns-expiration': String(apnsExpirationUnix()),
      'content-type': 'application/json',
    };
    const collapse = collapseId(payload);
    if (collapse) headers['apns-collapse-id'] = collapse;

    let req;
    try {
      req = client.request(headers);
    } catch (err) {
      clearTimeout(timer);
      finish(0, errorMessage(err));
      return;
    }

    let status = 0;
    let apnsId = null;
    let chunks = '';
    req.on('response', (resHeaders) => {
      status = Number(resHeaders[':status'] || 0);
      const id = resHeaders['apns-id'];
      apnsId = typeof id === 'string' ? id : null;
    });
    req.on('data', (chunk) => {
      chunks += chunk;
    });
    req.on('end', () => {
      clearTimeout(timer);
      let reason = null;
      if (chunks) {
        try {
          const parsed = JSON.parse(chunks);
          if (parsed && typeof parsed.reason === 'string') reason = parsed.reason;
        } catch {
          reason = chunks.slice(0, 200);
        }
      }
      finish(status, reason, apnsId);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      finish(0, errorMessage(err));
    });
    req.end(body);
  });
}

async function claimAdminPush(bookingUid, kind) {
  const key = adminPushDedupeKey(bookingUid, kind);
  const { rows } = await sql`
    INSERT INTO webhook_events (booking_uid)
    VALUES (${key})
    ON CONFLICT (booking_uid) DO NOTHING
    RETURNING booking_uid
  `;
  return rows.length > 0;
}

async function releaseAdminPushClaim(bookingUid, kind) {
  const key = adminPushDedupeKey(bookingUid, kind);
  try {
    await sql`DELETE FROM webhook_events WHERE booking_uid = ${key}`;
  } catch (err) {
    console.warn('[admin-booking-push] failed to release dedupe claim', {
      error: errorMessage(err),
    });
  }
}

async function loadDevices() {
  await ensureAdminPushDevicesTable();
  const { rows } = await sql`
    SELECT device_token, bundle_id, environment
    FROM admin_push_devices
    ORDER BY updated_at DESC
  `;
  return rows.filter(
    (row) =>
      TOKEN_RE.test(String(row.device_token || '')) &&
      ALLOWED_BUNDLE_IDS.has(String(row.bundle_id || '')) &&
      (row.environment === 'development' || row.environment === 'production')
  );
}

async function deleteDeviceToken(deviceToken) {
  try {
    await sql`
      DELETE FROM admin_push_devices WHERE device_token = ${deviceToken}
    `;
  } catch (err) {
    console.warn('[admin-booking-push] failed to drop invalid token', {
      error: errorMessage(err),
    });
  }
}

function buildAlertPayload({
  kind,
  source,
  appointmentId,
  bookingUid,
  clientName,
  serviceName,
  bookingTime,
}) {
  const k = normalizeKind(kind);
  const admin = normalizeSource(source) === 'admin';
  const service = serviceLabel(serviceName);
  const when = formatDenverTime(bookingTime);
  const whoStart = displayWho(clientName, { capitalize: true });
  const whoMid = displayWho(clientName, { capitalize: false });

  let title;
  let body;
  if (k === 'rescheduled') {
    title = admin ? 'You rescheduled a booking' : 'Booking rescheduled';
    body = admin
      ? withWhen(`You rescheduled ${service} for ${whoMid}`, when)
      : withWhen(`${whoStart} rescheduled ${service}`, when);
  } else if (k === 'canceled') {
    title = admin ? 'You canceled a booking' : 'Booking canceled';
    body = admin
      ? withWhen(`You canceled ${service} for ${whoMid}`, when)
      : withWhen(`${whoStart} canceled ${service}`, when);
  } else {
    title = admin ? 'You scheduled a booking' : 'New booking';
    body = admin
      ? withWhen(`You scheduled ${service} for ${whoMid}`, when)
      : withWhen(`${whoStart} booked ${service}`, when);
  }

  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
      'content-available': 1,
      // Breaks through Focus / scheduled summary when the app carries the
      // Time Sensitive entitlement; iOS silently downgrades to `active`
      // otherwise, so this is safe for older installs.
      'interruption-level': 'time-sensitive',
    },
    kind: k,
    source: admin ? 'admin' : 'client',
    appointmentId: appointmentId || null,
    bookingUid: bookingUid || null,
  };
}

async function lookupAppointmentForPush(bookingUid) {
  try {
    const { rows } = await sql`
      SELECT
        id::text AS id,
        client_first_name,
        client_last_name,
        service_name,
        booking_time
      FROM appointments
      WHERE cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const clientName = [row.client_first_name, row.client_last_name]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => part.trim())
      .join(' ');
    return {
      id: row.id || null,
      clientName,
      serviceName: row.service_name || '',
      bookingTime: row.booking_time || null,
    };
  } catch (err) {
    console.warn('[admin-booking-push] appointment lookup failed', {
      error: errorMessage(err),
    });
    return null;
  }
}

function createQStashClient() {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = (process.env.QSTASH_URL?.trim() || DEFAULT_QSTASH_URL).replace(
    /\/$/,
    ''
  );
  return new QStashClient({ token, baseUrl });
}

/**
 * Queue attempt `payload.attempt` of this alert. Logs `retry_scheduled` or
 * `error`. Never throws.
 */
async function scheduleRetry(payload) {
  const attempt = normalizeAttempt(payload.attempt);
  const base = {
    bookingUid: payload.bookingUid,
    kind: payload.kind,
    source: payload.source,
    attempt,
  };
  if (attempt > MAX_ATTEMPTS) {
    await logDelivery({
      ...base,
      outcome: 'exhausted',
      detail: `gave up after ${MAX_ATTEMPTS} attempts`,
    });
    return { scheduled: false, reason: 'exhausted' };
  }
  const qstash = createQStashClient();
  if (!qstash) {
    console.error('[admin-booking-push] QStash missing — cannot retry APNs');
    await logDelivery({ ...base, outcome: 'error', detail: 'qstash_not_configured' });
    return { scheduled: false, reason: 'qstash_not_configured' };
  }
  const delay = retryDelaySec(attempt);
  try {
    const res = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/qstash/admin-booking-push`,
      body: payload,
      delay,
      retries: 3,
    });
    const messageId = typeof res?.messageId === 'string' ? res.messageId : undefined;
    await logDelivery({
      ...base,
      outcome: 'retry_scheduled',
      detail: `in ${delay}s${payload.reloadDevices ? ' (reload devices)' : ''}${
        Array.isArray(payload.tokens) ? ` for ${payload.tokens.length} token(s)` : ''
      }${messageId ? ` qstash=${messageId}` : ''}`,
    });
    return { scheduled: true, messageId };
  } catch (err) {
    console.error('[admin-booking-push] QStash retry publish failed', {
      error: errorMessage(err),
    });
    await logDelivery({
      ...base,
      outcome: 'error',
      detail: `qstash publish failed: ${errorMessage(err)}`,
    });
    return { scheduled: false, reason: errorMessage(err) };
  }
}

function retryBody({
  kind,
  source,
  appointmentId,
  bookingUid,
  clientName,
  serviceName,
  bookingTime,
  tokens,
  reloadDevices,
  attempt,
}) {
  return {
    kind: normalizeKind(kind),
    source: normalizeSource(source),
    appointmentId: appointmentId || null,
    bookingUid,
    clientName,
    serviceName,
    bookingTime,
    attempt: normalizeAttempt(attempt),
    ...(reloadDevices ? { reloadDevices: true } : { tokens }),
  };
}

/**
 * Send to a specific token list. Does not touch webhook_events.
 * Logs one admin_push_deliveries row per token.
 *
 * @returns {Promise<{ ok: boolean, sent: number, retryable: Array<object>, invalid: number, skipped?: string }>}
 */
async function sendAdminBookingPushToTokens({
  tokens,
  kind,
  source,
  appointmentId,
  bookingUid,
  clientName,
  serviceName,
  bookingTime,
  requestHost = null,
  attempt = 1,
}) {
  const resolvedKind = normalizeKind(kind);
  const resolvedSource = normalizeSource(source);
  const resolvedAttempt = normalizeAttempt(attempt);
  const logBase = {
    bookingUid,
    kind: resolvedKind,
    source: resolvedSource,
    attempt: resolvedAttempt,
  };

  if (!shouldSendAdminPush(requestHost)) {
    return { ok: true, skipped: 'non_production', sent: 0, retryable: [], invalid: 0 };
  }

  let jwt = await apnsJwt();
  if (!jwt.ok) {
    await logDelivery({ ...logBase, outcome: 'skipped', detail: jwt.error });
    return { ok: false, skipped: jwt.error, sent: 0, retryable: [], invalid: 0 };
  }

  const alert = buildAlertPayload({
    kind: resolvedKind,
    source: resolvedSource,
    appointmentId,
    bookingUid,
    clientName,
    serviceName,
    bookingTime,
  });

  const retryable = [];
  let sent = 0;
  let invalid = 0;
  let resignedOnce = false;

  for (const row of tokens || []) {
    const deviceToken = String(row.device_token || '').toLowerCase();
    const bundleId = String(row.bundle_id || '');
    const environment = row.environment;
    if (!TOKEN_RE.test(deviceToken) || !ALLOWED_BUNDLE_IDS.has(bundleId)) {
      continue;
    }
    const tokenLog = {
      ...logBase,
      tokenPrefix: tokenPrefix(deviceToken),
      bundleId,
      environment,
    };

    let result = await postApns({
      token: deviceToken,
      jwt: jwt.token,
      bundleId,
      payload: alert,
      environment,
    });

    if (isProviderTokenStatus(result.status, result.reason) && !resignedOnce) {
      // Stored JWT went stale / was signed with a rotated key. Re-sign once
      // for this whole batch and retry the same token immediately.
      resignedOnce = true;
      await logDelivery({
        ...tokenLog,
        outcome: 'retryable',
        apnsStatus: result.status,
        apnsReason: result.reason,
        detail: 'provider token rejected — re-signing',
      });
      const fresh = await apnsJwt({ forceRefresh: true });
      if (fresh.ok) {
        jwt = fresh;
        result = await postApns({
          token: deviceToken,
          jwt: jwt.token,
          bundleId,
          payload: alert,
          environment,
        });
      }
    }

    if (result.status === 200) {
      sent += 1;
      await logDelivery({
        ...tokenLog,
        outcome: 'sent',
        apnsStatus: 200,
        apnsId: result.apnsId,
      });
      continue;
    }

    if (isInvalidTokenStatus(result.status, result.reason)) {
      console.warn('[admin-booking-push] dropping invalid token', {
        status: result.status,
        reason: result.reason,
      });
      await deleteDeviceToken(deviceToken);
      invalid += 1;
      await logDelivery({
        ...tokenLog,
        outcome: 'invalid_token',
        apnsStatus: result.status,
        apnsReason: result.reason,
        detail: 'token removed; app re-registers on next foreground',
      });
      continue;
    }

    if (
      isRetryableStatus(result.status, result.reason) ||
      isProviderTokenStatus(result.status, result.reason)
    ) {
      retryable.push({
        device_token: deviceToken,
        bundle_id: bundleId,
        environment,
      });
      await logDelivery({
        ...tokenLog,
        outcome: 'retryable',
        apnsStatus: result.status,
        apnsReason: result.reason,
      });
      continue;
    }

    console.warn('[admin-booking-push] APNs rejected', {
      status: result.status,
      reason: result.reason,
    });
    await logDelivery({
      ...tokenLog,
      outcome: 'rejected',
      apnsStatus: result.status,
      apnsReason: result.reason,
    });
  }

  return { ok: true, sent, retryable, invalid };
}

/**
 * Entry for confirmed / rescheduled / canceled admin iOS alerts.
 * Idempotent per Cal booking UID + kind.
 */
async function notifyAdminAppointmentPush({
  kind = 'confirmed',
  source = 'client',
  bookingUid,
  bookingTime = null,
  clientName = '',
  serviceName = '',
  appointmentId = null,
  skipIfAlreadySent = true,
  requestHost = null,
}) {
  const uid = typeof bookingUid === 'string' ? bookingUid.trim() : '';
  const resolvedKind = normalizeKind(kind);
  const resolvedSource = normalizeSource(source);
  const logBase = { bookingUid: uid, kind: resolvedKind, source: resolvedSource, attempt: 1 };

  if (!uid) {
    // Rows without a Cal UID (e.g. a manual booking whose Cal create failed)
    // cannot be deduped and are not alerted. Log so the audit shows them.
    await logDelivery({
      ...logBase,
      bookingUid: appointmentId ? `appointment:${appointmentId}` : '(none)',
      outcome: 'skipped',
      detail: 'missing_booking_uid',
    });
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  if (!shouldSendAdminPush(requestHost)) {
    console.log('[admin-booking-push] skipped — non-production deployment', {
      bookingUid: uid,
      kind: resolvedKind,
      source: resolvedSource,
    });
    return { ok: true, skipped: 'non_production' };
  }

  let claimed = false;
  try {
    if (!apnsCredentials()) {
      console.warn('[admin-booking-push] skipped — APNs env not configured');
      await logDelivery({ ...logBase, outcome: 'skipped', detail: 'apns_not_configured' });
      return { ok: true, skipped: 'apns_not_configured' };
    }

    if (skipIfAlreadySent) {
      claimed = await claimAdminPush(uid, resolvedKind);
      if (!claimed) {
        return { ok: true, skipped: 'already_sent' };
      }
    }

    const devices = await loadDevices();

    let resolvedAppointmentId = appointmentId || null;
    let resolvedClientName =
      typeof clientName === 'string' ? clientName.trim() : '';
    let resolvedServiceName = serviceName;
    let resolvedBookingTime = bookingTime;
    if (
      !resolvedAppointmentId ||
      !resolvedClientName ||
      !resolvedServiceName ||
      !resolvedBookingTime
    ) {
      const looked = await lookupAppointmentForPush(uid);
      if (looked) {
        resolvedAppointmentId = resolvedAppointmentId || looked.id;
        resolvedClientName = resolvedClientName || looked.clientName;
        resolvedServiceName = resolvedServiceName || looked.serviceName;
        resolvedBookingTime = resolvedBookingTime || looked.bookingTime;
      }
    }

    const body = {
      kind: resolvedKind,
      source: resolvedSource,
      appointmentId: resolvedAppointmentId,
      bookingUid: uid,
      clientName: resolvedClientName,
      serviceName: resolvedServiceName,
      bookingTime: resolvedBookingTime,
    };

    if (devices.length === 0) {
      // The iOS token may land a moment later (first launch / Clerk still
      // hydrating / token rotated). Keep the claim — the QStash chain owns
      // this alert now and reloads devices on every attempt.
      await logDelivery({ ...logBase, outcome: 'skipped', detail: 'no_devices' });
      const delayed = await scheduleRetry(
        retryBody({ ...body, reloadDevices: true, attempt: 2 })
      );
      if (!delayed.scheduled && claimed) {
        await releaseAdminPushClaim(uid, resolvedKind);
      }
      return {
        ok: true,
        skipped: 'no_devices',
        sent: 0,
        retryScheduled: delayed.scheduled,
      };
    }

    const result = await sendAdminBookingPushToTokens({
      ...body,
      tokens: devices,
      requestHost,
      attempt: 1,
    });

    let retryScheduled = false;
    if (result.retryable && result.retryable.length > 0) {
      const delayed = await scheduleRetry(
        retryBody({ ...body, tokens: result.retryable, attempt: 2 })
      );
      retryScheduled = delayed.scheduled;
    } else if (result.sent === 0 && result.invalid > 0) {
      // Every registered token was dead. The app re-registers on its next
      // foreground / silent push, so give it a chance to catch this alert.
      const delayed = await scheduleRetry(
        retryBody({ ...body, reloadDevices: true, attempt: 2 })
      );
      retryScheduled = delayed.scheduled;
    }

    if (result.sent === 0 && !retryScheduled && claimed) {
      // Nothing landed and nothing is queued — let the next lifecycle path
      // (Cal webhook after checkout confirm, admin retry, …) send it.
      await releaseAdminPushClaim(uid, resolvedKind);
    }

    return {
      ok: true,
      sent: result.sent,
      retryable: result.retryable?.length || 0,
      invalid: result.invalid || 0,
      retryScheduled,
    };
  } catch (err) {
    console.error('[admin-booking-push] notify failed (non-blocking)', {
      bookingUid: uid,
      kind: resolvedKind,
      error: errorMessage(err),
    });
    await logDelivery({ ...logBase, outcome: 'error', detail: errorMessage(err) });
    if (claimed) {
      // Hand the alert to QStash rather than leaving a claim with no send.
      const delayed = await scheduleRetry(
        retryBody({
          kind: resolvedKind,
          source: resolvedSource,
          appointmentId,
          bookingUid: uid,
          clientName,
          serviceName,
          bookingTime,
          reloadDevices: true,
          attempt: 2,
        })
      );
      if (!delayed.scheduled) {
        await releaseAdminPushClaim(uid, resolvedKind);
      }
    }
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * QStash worker body for /api/qstash/admin-booking-push.
 * Sends to the carried tokens (or reloads registered devices), then either
 * finishes, re-queues leftovers, or gives up after MAX_ATTEMPTS.
 *
 * @returns {Promise<{ ok: boolean, sent: number, status: number, skipped?: string, retryScheduled?: boolean }>}
 *   `status` is the HTTP status the route should answer with: 200 when the
 *   chain is handled (done, re-queued, or exhausted); 503 when the send
 *   failed AND we could not re-queue, so QStash's own retries kick in.
 */
async function runAdminPushRetry({ body, requestHost = null }) {
  const parsed = body && typeof body === 'object' ? body : {};
  const bookingUid =
    typeof parsed.bookingUid === 'string' ? parsed.bookingUid.trim() : '';
  const kind = normalizeKind(parsed.kind);
  const source = normalizeSource(parsed.source);
  const attempt = normalizeAttempt(parsed.attempt || 2);
  const logBase = { bookingUid, kind, source, attempt };

  if (!bookingUid) {
    return { ok: true, sent: 0, status: 200, skipped: 'missing_booking_uid' };
  }

  let tokens = Array.isArray(parsed.tokens)
    ? parsed.tokens.filter(
        (row) =>
          row &&
          typeof row.device_token === 'string' &&
          typeof row.bundle_id === 'string' &&
          (row.environment === 'development' || row.environment === 'production')
      )
    : [];

  const base = {
    kind,
    source,
    appointmentId: parsed.appointmentId ?? null,
    bookingUid,
    clientName: parsed.clientName,
    serviceName: parsed.serviceName,
    bookingTime: parsed.bookingTime,
  };

  try {
    if (parsed.reloadDevices === true) {
      tokens = await loadDevices();
    }

    if (tokens.length === 0) {
      await logDelivery({ ...logBase, outcome: 'skipped', detail: 'no_devices' });
      const delayed = await scheduleRetry(
        retryBody({ ...base, reloadDevices: true, attempt: attempt + 1 })
      );
      if (!delayed.scheduled && delayed.reason !== 'exhausted' && attempt < MAX_ATTEMPTS) {
        return { ok: false, sent: 0, status: 503, skipped: 'no_devices' };
      }
      if (delayed.reason === 'exhausted') {
        // Nobody is registered any more — release so a later confirm/cancel
        // path can alert once a phone signs back in.
        await releaseAdminPushClaim(bookingUid, kind);
      }
      return { ok: true, sent: 0, status: 200, skipped: 'no_devices', retryScheduled: delayed.scheduled };
    }

    const result = await sendAdminBookingPushToTokens({
      ...base,
      tokens,
      requestHost,
      attempt,
    });

    if (result.skipped) {
      return { ok: true, sent: 0, status: 200, skipped: result.skipped };
    }

    let retryScheduled = false;
    if (result.retryable && result.retryable.length > 0) {
      const delayed = await scheduleRetry(
        retryBody({ ...base, tokens: result.retryable, attempt: attempt + 1 })
      );
      retryScheduled = delayed.scheduled;
      if (!retryScheduled && result.sent === 0 && delayed.reason !== 'exhausted') {
        return { ok: false, sent: 0, status: 503, retryScheduled: false };
      }
    } else if (result.sent === 0 && result.invalid > 0) {
      const delayed = await scheduleRetry(
        retryBody({ ...base, reloadDevices: true, attempt: attempt + 1 })
      );
      retryScheduled = delayed.scheduled;
    }

    return { ok: true, sent: result.sent, status: 200, retryScheduled };
  } catch (err) {
    console.error('[admin-booking-push] retry worker failed', {
      bookingUid,
      kind,
      attempt,
      error: errorMessage(err),
    });
    await logDelivery({ ...logBase, outcome: 'error', detail: errorMessage(err) });
    return { ok: false, sent: 0, status: 503 };
  }
}

/**
 * Entry from notifyBookingConfirmed. Idempotent per Cal booking UID.
 */
async function notifyAdminBookingConfirmed(args) {
  return notifyAdminAppointmentPush({ ...args, kind: 'confirmed' });
}

module.exports = {
  MAX_ATTEMPTS,
  ensureAdminPushDevicesTable,
  ensureAdminPushLogTables: ensureLogTables,
  notifyAdminAppointmentPush,
  notifyAdminBookingConfirmed,
  sendAdminBookingPushToTokens,
  runAdminPushRetry,
  loadDevices,
  adminPushDedupeKey,
};
