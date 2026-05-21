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

const buildMessage = ({ clientName, serviceName, bookingUid }) => {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  return `Hi ${clientName}! 🤍 Your ${serviceName} at Sadie Marie is confirmed. To view policies, reschedule, or cancel, use your secure link: ${link}`;
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // TEMP DEBUG: dump the raw incoming Cal.com payload so we can confirm
  // the actual shape of `responses` and where the phone number lives.
  // Remove once the payload structure is known.
  console.log('INCOMING PAYLOAD:', JSON.stringify(req.body, null, 2));

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

  const clientName = unwrap(attendee.name) || unwrap(responses.name) || 'there';
  const clientPhone = unwrap(responses.phone);
  const serviceName = unwrap(payload.title) || 'appointment';
  const bookingUid = unwrap(payload.uid);

  // Sanity-check that we have what we need to send a useful SMS. Bail
  // gracefully with 200 if anything's missing.
  if (!clientPhone) {
    console.warn('[api/webhook] no phone number on payload — skipping SMS', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'no_phone' });
  }
  if (!bookingUid) {
    console.warn('[api/webhook] no booking uid on payload — skipping SMS');
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
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
    console.log('[api/webhook] SMS sent', { sid: message.sid, to: clientPhone, bookingUid });
    return res.status(200).json({ ok: true, smsSid: message.sid });
  } catch (err) {
    // Per spec: always 200 so Cal.com doesn't retry. Log details for us.
    console.error('[api/webhook] Twilio send failed:', {
      bookingUid,
      to: clientPhone,
      code: err && err.code,
      status: err && err.status,
      message: err && err.message
    });
    return res.status(200).json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};
