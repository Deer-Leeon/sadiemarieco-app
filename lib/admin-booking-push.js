/**
 * Admin iOS APNs: register table helpers, send on booking confirm, QStash retry.
 *
 * Never throws to callers of notifyAdminBookingConfirmed — checkout must
 * succeed even if Apple is down. Retryable Apple 5xx is queued to
 * /api/qstash/admin-booking-push.
 */

const crypto = require('crypto');
const http2 = require('http2');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');

const TOKEN_RE = /^[A-Fa-f0-9]{64,200}$/;
const DEDUPE_SUFFIX = ':admin_push';
const JWT_TTL_SEC = 50 * 60;
/** Keep undelivered alerts on APNs for a week (UNIX timestamp). */
const APNS_STORE_SEC = 7 * 24 * 60 * 60;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';
const DEFAULT_QSTASH_URL = 'https://qstash-us-east-1.upstash.io';

const ALLOWED_BUNDLE_IDS = new Set([
  'com.lj-buchmiller.SadieMarie',
  'com.lj-buchmiller.SadieMarie.dev',
]);

let tableEnsured = false;
let cachedJwt = { token: '', exp: 0 };

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function adminPushDedupeKey(bookingUid) {
  return `${String(bookingUid || '').trim()}${DEDUPE_SUFFIX}`;
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

function apnsJwt() {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const pem = normalizePem(process.env.APNS_P8);
  if (!keyId || !teamId || !pem) {
    return { ok: false, error: 'apns_not_configured' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt.token && cachedJwt.exp - 60 > now) {
    return { ok: true, token: cachedJwt.token };
  }
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId }),
    'utf8'
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: teamId, iat: now }),
    'utf8'
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  let signature;
  try {
    signature = crypto
      .createSign('SHA256')
      .update(unsigned)
      .sign({ key: pem, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
  } catch (err) {
    return { ok: false, error: `apns_jwt_sign_failed: ${errorMessage(err)}` };
  }
  const token = `${unsigned}.${signature}`;
  cachedJwt = { token, exp: now + JWT_TTL_SEC };
  return { ok: true, token };
}

function apnsExpirationUnix() {
  return Math.floor(Date.now() / 1000) + APNS_STORE_SEC;
}

function collapseId(payload) {
  const uid =
    payload && typeof payload.bookingUid === 'string' ? payload.bookingUid.trim() : '';
  return uid ? uid.slice(0, 64) : '';
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
    r === 'deviceunregistered'
  );
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * @returns {Promise<{ status: number, reason: string | null }>}
 */
function postApns({ token, jwt, bundleId, payload, environment }) {
  const host = apnsHost(environment);
  const path = `/3/device/${token}`;
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, reason) => {
      if (settled) return;
      settled = true;
      resolve({ status, reason });
    };

    let client;
    try {
      client = http2.connect(host);
    } catch (err) {
      finish(0, errorMessage(err));
      return;
    }

    const timer = setTimeout(() => {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      finish(0, 'timeout');
    }, 8000);

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

    const req = client.request(headers);

    let status = 0;
    let chunks = '';
    req.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
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
      try {
        client.close();
      } catch {
        /* ignore */
      }
      finish(status, reason);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      finish(0, errorMessage(err));
    });
    req.end(body);
  });
}

async function claimAdminPush(bookingUid) {
  const key = adminPushDedupeKey(bookingUid);
  const { rows } = await sql`
    INSERT INTO webhook_events (booking_uid)
    VALUES (${key})
    ON CONFLICT (booking_uid) DO NOTHING
    RETURNING booking_uid
  `;
  return rows.length > 0;
}

async function releaseAdminPushClaim(bookingUid) {
  const key = adminPushDedupeKey(bookingUid);
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
  appointmentId,
  bookingUid,
  clientName,
  serviceName,
  bookingTime,
}) {
  const service = serviceLabel(serviceName);
  const when = formatDenverTime(bookingTime);
  const who = (clientName || 'A client').trim() || 'A client';
  const title = 'New booking';
  const body = when
    ? `${who} booked ${service} · ${when}`
    : `${who} booked ${service}`;
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
      'content-available': 1,
    },
    appointmentId: appointmentId || null,
    bookingUid: bookingUid || null,
  };
}

async function lookupAppointmentId(bookingUid) {
  try {
    const { rows } = await sql`
      SELECT id::text AS id
      FROM appointments
      WHERE cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    return rows[0]?.id || null;
  } catch (err) {
    console.warn('[admin-booking-push] appointment id lookup failed', {
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

async function scheduleRetry(payload) {
  const qstash = createQStashClient();
  if (!qstash) {
    console.error('[admin-booking-push] QStash missing — cannot retry APNs 5xx');
    return { scheduled: false, reason: 'qstash_not_configured' };
  }
  try {
    const res = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/qstash/admin-booking-push`,
      body: payload,
      delay: 15,
    });
    return {
      scheduled: true,
      messageId: typeof res?.messageId === 'string' ? res.messageId : undefined,
    };
  } catch (err) {
    console.error('[admin-booking-push] QStash retry publish failed', {
      error: errorMessage(err),
    });
    return { scheduled: false, reason: errorMessage(err) };
  }
}

/**
 * Send to a specific token list (QStash retry). Does not touch webhook_events.
 */
async function sendAdminBookingPushToTokens({
  tokens,
  appointmentId,
  bookingUid,
  clientName,
  serviceName,
  bookingTime,
}) {
  const jwt = apnsJwt();
  if (!jwt.ok) {
    return { ok: false, skipped: jwt.error, sent: 0 };
  }

  const alert = buildAlertPayload({
    appointmentId,
    bookingUid,
    clientName,
    serviceName,
    bookingTime,
  });

  const retryable = [];
  let sent = 0;

  for (const row of tokens || []) {
    const deviceToken = String(row.device_token || '').toLowerCase();
    const bundleId = String(row.bundle_id || '');
    const environment = row.environment;
    if (!TOKEN_RE.test(deviceToken) || !ALLOWED_BUNDLE_IDS.has(bundleId)) {
      continue;
    }
    const result = await postApns({
      token: deviceToken,
      jwt: jwt.token,
      bundleId,
      payload: alert,
      environment,
    });
    if (result.status === 200) {
      sent += 1;
      continue;
    }
    if (isInvalidTokenStatus(result.status, result.reason)) {
      console.warn('[admin-booking-push] dropping invalid token', {
        status: result.status,
        reason: result.reason,
      });
      await deleteDeviceToken(deviceToken);
      continue;
    }
    if (isRetryableStatus(result.status) || result.status === 0) {
      retryable.push({
        device_token: deviceToken,
        bundle_id: bundleId,
        environment,
      });
      continue;
    }
    console.warn('[admin-booking-push] APNs rejected', {
      status: result.status,
      reason: result.reason,
    });
  }

  return { ok: true, sent, retryable };
}

/**
 * Entry from notifyBookingConfirmed. Idempotent per Cal booking UID.
 */
async function notifyAdminBookingConfirmed({
  bookingUid,
  bookingTime = null,
  clientName = '',
  serviceName = '',
  appointmentId = null,
  skipIfAlreadySent = true,
}) {
  const uid = typeof bookingUid === 'string' ? bookingUid.trim() : '';
  if (!uid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  try {
    const jwt = apnsJwt();
    if (!jwt.ok) {
      console.warn('[admin-booking-push] skipped — APNs env not configured', {
        error: jwt.error,
      });
      return { ok: true, skipped: jwt.error };
    }

    if (skipIfAlreadySent) {
      const claimed = await claimAdminPush(uid);
      if (!claimed) {
        return { ok: true, skipped: 'already_sent' };
      }
    }

    const devices = await loadDevices();
    if (devices.length === 0) {
      // Do not keep the dedupe claim — the iOS token may land a moment later
      // (first launch / Clerk still hydrating). A later confirm path can send.
      if (skipIfAlreadySent) {
        await releaseAdminPushClaim(uid);
      }
      const delayed = await scheduleRetry({
        reloadDevices: true,
        appointmentId: appointmentId || null,
        bookingUid: uid,
        clientName,
        serviceName,
        bookingTime,
      });
      return {
        ok: true,
        skipped: 'no_devices',
        sent: 0,
        retryScheduled: delayed.scheduled,
      };
    }

    const resolvedAppointmentId =
      appointmentId || (await lookupAppointmentId(uid));

    const result = await sendAdminBookingPushToTokens({
      tokens: devices,
      appointmentId: resolvedAppointmentId,
      bookingUid: uid,
      clientName,
      serviceName,
      bookingTime,
    });

    if (result.retryable && result.retryable.length > 0) {
      await scheduleRetry({
        tokens: result.retryable,
        appointmentId: resolvedAppointmentId,
        bookingUid: uid,
        clientName,
        serviceName,
        bookingTime,
      });
    }

    if (result.sent === 0 && result.retryable && result.retryable.length > 0) {
      // Nothing landed yet — let a later QStash attempt claim-skip itself
      // by sending directly to remaining tokens (skipIfAlreadySent false).
    }

    return {
      ok: true,
      sent: result.sent,
      retryable: result.retryable?.length || 0,
    };
  } catch (err) {
    console.error('[admin-booking-push] notify failed (non-blocking)', {
      bookingUid: uid,
      error: errorMessage(err),
    });
    return { ok: false, error: errorMessage(err) };
  }
}

module.exports = {
  ensureAdminPushDevicesTable,
  notifyAdminBookingConfirmed,
  sendAdminBookingPushToTokens,
  loadDevices,
  adminPushDedupeKey,
};
