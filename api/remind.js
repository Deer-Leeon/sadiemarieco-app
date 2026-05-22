/**
 * POST /api/remind
 *
 * QStash-triggered handler that sends a 24-hour reminder SMS. Scheduled by
 * api/webhook.js at booking-creation time with notBefore = appointmentTime - 24h.
 *
 * Contract:
 *   - Must verify the Upstash signature before doing any work (this URL is
 *     public; anyone who guesses it could otherwise replay reminders).
 *   - Must always return 200 OK on logical skips (cancelled appointment,
 *     missing phone, DB error) so QStash doesn't enter a retry loop.
 *   - Reads the appointment row from Postgres — the canonical source of
 *     truth for "is this still confirmed?" — rather than trusting any state
 *     embedded in the QStash payload, which was captured 24h ago.
 *
 * Required environment variables:
 *   - QSTASH_CURRENT_SIGNING_KEY
 *   - QSTASH_NEXT_SIGNING_KEY    (recommended for zero-downtime key rotation)
 *   - POSTGRES_URL               (read by @vercel/postgres)
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER
 *   - PUBLIC_BASE_URL            (optional override; defaults to prod domain)
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Receiver } = require('@upstash/qstash');

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://sadiemarieco.vercel.app';
const MANAGE_LINK_BASE = `${PUBLIC_BASE_URL}/manage.html`;

const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

// QStash signs the raw HTTP body. We need those exact bytes back to verify.
// We disable Vercel's auto body-parser (see config export below) and read
// the stream manually. The string/object branches are defensive fallbacks
// for runtimes that still pre-parse — JSON.stringify of a parsed object is
// fragile (key ordering, whitespace) and will likely fail verification, but
// it's better than crashing on an unexpected input shape.
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

const buildMessage = ({ firstName, serviceName, bookingUid }) => {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  const who = firstName || 'there';
  const what = serviceName || 'appointment';
  return `Hi ${who}! 🤍 Just a quick reminder that your ${what} at Sadie Marie is tomorrow. Need to adjust your time? Manage it securely here: ${link}\n\n${FOOTER_NOTE}`;
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
    console.error('[api/remind] failed to read body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'body_read_failed' });
  }

  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY) {
    // 500 here (not 200) because misconfiguration is our fault and we want
    // QStash's dead-letter queue to surface it loudly rather than silently
    // dropping every reminder.
    console.error('[api/remind] QSTASH_CURRENT_SIGNING_KEY missing — refusing to process');
    return res.status(500).json({ error: 'signing_key_not_configured' });
  }

  const signature = req.headers['upstash-signature'];
  if (!signature) {
    console.warn('[api/remind] missing upstash-signature header');
    return res.status(401).json({ error: 'missing_signature' });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      console.warn('[api/remind] invalid signature');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  } catch (err) {
    console.warn('[api/remind] signature verification threw:', err && err.message);
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // ── PARSE BODY ──────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch (err) {
    console.error('[api/remind] invalid JSON body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  const bookingUid = body && body.bookingUid;
  if (!bookingUid) {
    console.warn('[api/remind] no bookingUid in body');
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
  }

  // ── APPOINTMENT LOOKUP + STATUS GATE ────────────────────────────────────
  // Reads the row at delivery time, not at schedule time, so cancellations
  // made in the intervening window are honored. NOTE: this gate only works
  // if api/cancel-booking.js (or a BOOKING_CANCELLED webhook) flips
  // appointments.status = 'cancelled' on cancel — currently it does not.
  let appointment;
  try {
    const { rows } = await sql`
      SELECT cal_event_id, status, service_name, client_first_name, client_phone
      FROM appointments
      WHERE cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    appointment = rows[0];
  } catch (err) {
    console.error('[api/remind] appointment lookup failed:', {
      bookingUid,
      error: err && err.message,
    });
    return res.status(200).json({ ok: true, skipped: 'db_lookup_failed' });
  }

  if (!appointment) {
    console.warn('[api/remind] appointment not found — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'not_found' });
  }

  if (appointment.status && appointment.status !== 'confirmed') {
    console.log('[api/remind] appointment not confirmed — skipping', {
      bookingUid,
      status: appointment.status,
    });
    return res.status(200).json({ ok: true, skipped: 'status_not_confirmed' });
  }

  const clientPhone = appointment.client_phone;
  if (!clientPhone) {
    console.warn('[api/remind] no phone on appointment — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'no_phone' });
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[api/remind] Twilio env vars missing', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'twilio_not_configured' });
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const msg = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: clientPhone,
      body: buildMessage({
        firstName: appointment.client_first_name,
        serviceName: appointment.service_name,
        bookingUid,
      }),
    });
    console.log('[api/remind] SMS sent', {
      sid: msg.sid,
      to: maskPhone(clientPhone),
      bookingUid,
    });
    return res.status(200).json({ ok: true, smsSid: msg.sid });
  } catch (err) {
    // 200 (not 5xx) so QStash doesn't retry — a flaky carrier failure 24h
    // out should not produce a retry storm. The log is our signal.
    console.error('[api/remind] Twilio send failed:', {
      bookingUid,
      to: maskPhone(clientPhone),
      code: err && err.code,
      status: err && err.status,
      message: err && err.message,
    });
    return res.status(200).json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};

// Opt out of Vercel's JSON auto-parsing so signature verification can read
// the unmodified request bytes. Without this, the raw stream is consumed
// before our handler runs and QStash signature checks will reject every
// request because the re-serialised JSON bytes won't match the signed input.
module.exports.config = { api: { bodyParser: false } };
