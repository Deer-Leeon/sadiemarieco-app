/**
 * POST /api/feedback
 *
 * QStash-triggered handler that sends a 24-hour follow-up / thank-you SMS.
 * Scheduled by api/webhook.js at booking-creation time with
 * notBefore = appointmentTime + 24h.
 *
 * Contract:
 *   - Verifies the Upstash signature before doing anything.
 *   - Always returns 200 OK on logical skips so QStash doesn't retry.
 *   - We DO still gate on appointments.status: sending "thanks for visiting!"
 *     to a client who cancelled is worse than not following the spec
 *     literally. The status check is a no-op if your cancel flow doesn't
 *     update the column yet — it just means everyone gets thanked.
 *
 * Required environment variables: same as api/remind.js.
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Receiver } = require('@upstash/qstash');

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://sadiemarieco.vercel.app';

const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

const readRawBody = (req) => new Promise((resolve, reject) => {
  if (typeof req.body === 'string') return resolve(req.body);
  if (req.body && typeof req.body === 'object') return resolve(JSON.stringify(req.body));
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});

// TODO: Replace the placeholder below with the real Google Voice number
// before going live. This string is sent to every client verbatim — leaving
// the placeholder in production means clients will literally see
// "[Insert Your Google Voice Number Here]" in their inbox.
const GOOGLE_VOICE_NUMBER = '[Insert Your Google Voice Number Here]';
const FOOTER_NOTE = `(Note: This is an automated line. To reach the studio directly, please call or text ${GOOGLE_VOICE_NUMBER}).`;

const buildMessage = ({ firstName }) => {
  const who = firstName || 'there';
  return `Hi ${who}! 🤍 Thank you so much for visiting Sadie Marie yesterday. We loved having you in the studio! When you are ready, you can book your next session here: ${PUBLIC_BASE_URL}\n\n${FOOTER_NOTE}`;
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ── SIGNATURE VERIFICATION ──────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[api/feedback] failed to read body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'body_read_failed' });
  }

  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY) {
    console.error('[api/feedback] QSTASH_CURRENT_SIGNING_KEY missing — refusing to process');
    return res.status(500).json({ error: 'signing_key_not_configured' });
  }

  const signature = req.headers['upstash-signature'];
  if (!signature) {
    console.warn('[api/feedback] missing upstash-signature header');
    return res.status(401).json({ error: 'missing_signature' });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      console.warn('[api/feedback] invalid signature');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  } catch (err) {
    console.warn('[api/feedback] signature verification threw:', err && err.message);
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // ── PARSE BODY ──────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch (err) {
    console.error('[api/feedback] invalid JSON body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  const bookingUid = body && body.bookingUid;
  if (!bookingUid) {
    console.warn('[api/feedback] no bookingUid in body');
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
  }

  // ── APPOINTMENT LOOKUP ──────────────────────────────────────────────────
  let appointment;
  try {
    const { rows } = await sql`
      SELECT cal_event_id, status, client_first_name, client_phone
      FROM appointments
      WHERE cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    appointment = rows[0];
  } catch (err) {
    console.error('[api/feedback] appointment lookup failed:', {
      bookingUid,
      error: err && err.message,
    });
    return res.status(200).json({ ok: true, skipped: 'db_lookup_failed' });
  }

  if (!appointment) {
    console.warn('[api/feedback] appointment not found — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'not_found' });
  }

  // Defensive status gate — don't thank a no-show or cancelled client. Safe
  // to keep even if your cancel flow doesn't write status yet (the check
  // simply passes through for everyone in that case).
  if (appointment.status && appointment.status !== 'confirmed') {
    console.log('[api/feedback] appointment not confirmed — skipping', {
      bookingUid,
      status: appointment.status,
    });
    return res.status(200).json({ ok: true, skipped: 'status_not_confirmed' });
  }

  const clientPhone = appointment.client_phone;
  if (!clientPhone) {
    console.warn('[api/feedback] no phone on appointment — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'no_phone' });
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[api/feedback] Twilio env vars missing', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'twilio_not_configured' });
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const msg = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: clientPhone,
      body: buildMessage({ firstName: appointment.client_first_name }),
    });
    console.log('[api/feedback] SMS sent', {
      sid: msg.sid,
      to: maskPhone(clientPhone),
      bookingUid,
    });
    return res.status(200).json({ ok: true, smsSid: msg.sid });
  } catch (err) {
    console.error('[api/feedback] Twilio send failed:', {
      bookingUid,
      to: maskPhone(clientPhone),
      code: err && err.code,
      status: err && err.status,
      message: err && err.message,
    });
    return res.status(200).json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};

module.exports.config = { api: { bodyParser: false } };
