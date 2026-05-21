/**
 * POST /api/webhook
 *
 * Receives Cal.com webhook events (configured with trigger BOOKING_CREATED)
 * and sends an SMS confirmation to the client via Twilio. Always returns
 * 200 OK to Cal.com — even on SMS failure — so Cal won't time out or retry
 * the webhook indefinitely. Errors are logged for our own debugging.
 *
 * Cal.com webhook payload reference:
 *   https://cal.com/docs/core-features/webhooks
 *
 * Required environment variables (set in Vercel → Project Settings → Env Vars):
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER   (the Twilio number the SMS is sent from)
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');

const MANAGE_LINK_BASE = 'https://sadiemarieco.vercel.app/manage.html';

// Cal.com normally sends application/json with the body already parsed by
// Vercel's Node runtime into req.body. If anything ever sends it as a raw
// stream, this fallback reconstructs and parses it so we don't drop events.
const readJsonBody = (req) => new Promise((resolve, reject) => {
  if (req.body && typeof req.body === 'object') return resolve(req.body);
  if (typeof req.body === 'string' && req.body.length) {
    try { return resolve(JSON.parse(req.body)); }
    catch (e) { return reject(e); }
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); }
    catch (e) { reject(e); }
  });
  req.on('error', reject);
});

// Cal sometimes wraps custom field values inside `{ label, value }`.
// Normalize to a plain string regardless of which shape we receive.
const unwrap = (val) => {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.value === 'string') return val.value;
  return String(val);
};

// Mask a phone number for log output — keeps the leading country code prefix
// and the last 4 digits, redacts the rest. Avoids dumping full PII into our
// Vercel log aggregator while preserving enough context to trace a failure.
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

// Mask an email for log output — keeps the first character of the local part
// and the full domain so failures can still be cross-referenced with bookings.
const maskEmail = (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '[redacted]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

// Split a Cal-supplied full name into first/last as a fallback when the
// dedicated firstName/lastName fields aren't populated.
const splitName = (fullName) => {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
};

const buildMessage = ({ clientName, serviceName, bookingUid }) => {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  return `Hi ${clientName}! 🤍 Your ${serviceName} at Sadie Marie is confirmed. To view policies, reschedule, or cancel, use your secure link: ${link}`;
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('[api/webhook] invalid JSON body:', err);
    // Still 200 — invalid payload isn't worth blocking Cal's queue over.
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  const payload = (body && body.payload) || {};
  const attendee = Array.isArray(payload.attendees) && payload.attendees[0] || {};
  const responses = payload.responses || {};

  // Cal.com puts the SMS-reminder number on the attendee record directly
  // (`attendees[0].phoneNumber`). The booking-question response object is a
  // fallback for older payloads where the value lives under
  // `responses.attendeePhoneNumber.value` (custom field wrapper shape).
  const clientName = unwrap(attendee.name) || unwrap(responses.name) || 'there';
  const clientPhone =
    unwrap(attendee.phoneNumber) ||
    unwrap(responses.attendeePhoneNumber) ||
    unwrap(responses.phone);
  const serviceName = unwrap(payload.title) || 'appointment';
  const bookingUid = unwrap(payload.uid);

  // Fields needed for the clients + appointments DB upserts.
  const clientEmail = unwrap(attendee.email) || unwrap(responses.email);
  const nameFallback = splitName(unwrap(attendee.name));
  const firstName = unwrap(attendee.firstName) || nameFallback.first || '';
  const lastName = unwrap(attendee.lastName) || nameFallback.last || '';
  // Cal sends ISO-8601 timestamps; Postgres TIMESTAMP/TIMESTAMPTZ accepts
  // them directly. Try webhook field name first, then fall back to v2 shape.
  const bookingTime = unwrap(payload.startTime) || unwrap(payload.start) || null;

  // Without a UID we can't dedupe or match an appointment record. Without
  // an email we can't upsert the client. Bail early in both cases.
  if (!bookingUid) {
    console.warn('[api/webhook] no booking uid on payload — skipping');
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
  }
  if (!clientEmail) {
    console.warn('[api/webhook] no email on payload — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'no_email' });
  }

  // ── IDEMPOTENCY GATE ─────────────────────────────────────────────────────
  // Cal.com sometimes re-delivers webhook events (retries on slow upstream,
  // operator-triggered replays from the dashboard, etc.). Before consuming
  // any Twilio quota OR doing duplicate DB writes, check whether we've
  // already processed this booking_uid. On DB failure we still return 200 —
  // never let infrastructure issues turn a single booking into a webhook
  // retry storm.
  try {
    const { rows } = await sql`
      SELECT 1 FROM webhook_events WHERE booking_uid = ${bookingUid} LIMIT 1
    `;
    if (rows.length > 0) {
      console.log('[api/webhook] duplicate webhook — already processed', { bookingUid });
      return res.status(200).json({ ok: true, skipped: 'duplicate' });
    }
  } catch (err) {
    console.error('[api/webhook] idempotency check failed:', {
      bookingUid,
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'db_check_failed' });
  }

  // ── CLIENT UPSERT ────────────────────────────────────────────────────────
  // Insert the client keyed by email. EXCLUDED refers to the row that would
  // have been inserted — we propagate name updates so subsequent bookings
  // pick up any profile changes the client made in Cal.com. RETURNING gives
  // us the id (whether the row was just inserted or already existed).
  let clientId;
  try {
    const { rows } = await sql`
      INSERT INTO clients (first_name, last_name, email)
      VALUES (${firstName}, ${lastName}, ${clientEmail})
      ON CONFLICT (email) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name
      RETURNING id
    `;
    clientId = rows[0] && rows[0].id;
    if (!clientId) {
      console.error('[api/webhook] client upsert returned no id', {
        bookingUid,
        email: maskEmail(clientEmail)
      });
      return res.status(200).json({ ok: true, skipped: 'client_upsert_no_id' });
    }
  } catch (err) {
    console.error('[api/webhook] client upsert failed:', {
      bookingUid,
      email: maskEmail(clientEmail),
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'client_upsert_failed' });
  }

  // ── APPOINTMENT UPSERT ──────────────────────────────────────────────────
  // Insert the appointment keyed by cal_event_id (payload.uid). Denormalised
  // client_* fields are stored alongside the client_id FK so the appointment
  // remains self-contained if the client row is ever deleted/anonymised.
  try {
    await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, cal_event_id,
        client_first_name, client_last_name, client_email
      )
      VALUES (
        ${clientId}, ${serviceName}, ${bookingTime}, ${bookingUid},
        ${firstName}, ${lastName}, ${clientEmail}
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        booking_time = EXCLUDED.booking_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = EXCLUDED.client_email
    `;
  } catch (err) {
    console.error('[api/webhook] appointment upsert failed:', {
      bookingUid,
      clientId,
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'appointment_upsert_failed' });
  }

  // SMS is best-effort beyond this point — the DB ingestion above is the
  // primary contract. If the client doesn't have a phone, mark the webhook
  // as processed via webhook_events anyway so we don't keep re-running the
  // DB writes on replays.
  if (!clientPhone) {
    console.warn('[api/webhook] no phone number — DB upsert complete, skipping SMS', { bookingUid });
    try {
      await sql`
        INSERT INTO webhook_events (booking_uid)
        VALUES (${bookingUid})
        ON CONFLICT (booking_uid) DO NOTHING
      `;
    } catch (dbErr) {
      console.error('[api/webhook] failed to record processed event (no-phone branch):', {
        bookingUid,
        error: dbErr && dbErr.message
      });
    }
    return res.status(200).json({ ok: true, skipped: 'no_phone', dbWritten: true });
  }

  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[api/webhook] Twilio env vars missing — cannot send SMS', {
      hasSid: !!TWILIO_ACCOUNT_SID,
      hasToken: !!TWILIO_AUTH_TOKEN,
      hasFrom: !!TWILIO_PHONE_NUMBER
    });
    return res.status(200).json({ ok: true, skipped: 'twilio_not_configured' });
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: clientPhone,
      body: buildMessage({ clientName, serviceName, bookingUid })
    });
    console.log('[api/webhook] SMS sent', { sid: message.sid, to: maskPhone(clientPhone), bookingUid });

    // ── PERSIST PROCESSED EVENT ────────────────────────────────────────────
    // Record this booking_uid so subsequent re-deliveries hit the dedup gate
    // above. ON CONFLICT DO NOTHING handles the rare race where two
    // simultaneous webhooks both passed the SELECT check before either
    // INSERTed (the UNIQUE constraint on booking_uid does the rest).
    // Per spec: log + 200 OK on failure so Cal never retries the request.
    try {
      await sql`
        INSERT INTO webhook_events (booking_uid)
        VALUES (${bookingUid})
        ON CONFLICT (booking_uid) DO NOTHING
      `;
    } catch (dbErr) {
      console.error('[api/webhook] failed to record processed event:', {
        bookingUid,
        error: dbErr && dbErr.message
      });
      // SMS already sent — return success but log so we can spot pattern of
      // future re-sends. Next duplicate webhook will likely re-send SMS.
    }

    return res.status(200).json({ ok: true, smsSid: message.sid });
  } catch (err) {
    // Per spec: always 200 so Cal.com doesn't retry. Log details for us.
    console.error('[api/webhook] Twilio send failed:', {
      bookingUid,
      to: maskPhone(clientPhone),
      code: err && err.code,
      status: err && err.status,
      message: err && err.message
    });
    return res.status(200).json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};
