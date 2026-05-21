/**
 * POST /api/reminder
 *
 * Receives Cal.com workflow webhook events configured to fire 24h before an
 * appointment and sends a reminder SMS via Twilio. Always returns 200 OK so
 * Cal.com's workflow engine won't time out or retry. Errors are logged for
 * our own debugging.
 *
 * Required environment variables:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER
 */

const twilio = require('twilio');

const MANAGE_LINK_BASE = 'https://sadiemarieco.vercel.app/manage.html';

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
// and the last 4 digits, redacts the rest.
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

const buildMessage = ({ clientName, serviceName, bookingUid }) => {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  return `Hi ${clientName}! 🤍 Just a quick reminder that your ${serviceName} at Sadie Marie is tomorrow. Need to adjust your time? Manage it securely here: ${link}`;
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
    console.error('[api/reminder] invalid JSON body:', err);
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  const payload = (body && body.payload) || {};
  const attendee = Array.isArray(payload.attendees) && payload.attendees[0] || {};
  const responses = payload.responses || {};

  const clientName = unwrap(attendee.firstName) || unwrap(attendee.name) || 'there';
  const clientPhone =
    unwrap(attendee.phoneNumber) ||
    unwrap(responses.attendeePhoneNumber) ||
    unwrap(responses.phone);
  const serviceName = unwrap(payload.title) || 'appointment';
  const bookingUid = unwrap(payload.uid);

  if (!clientPhone) {
    console.warn('[api/reminder] no phone number on payload — skipping SMS', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'no_phone' });
  }
  if (!bookingUid) {
    console.warn('[api/reminder] no booking uid on payload — skipping SMS');
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
  }

  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[api/reminder] Twilio env vars missing — cannot send SMS', {
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
    console.log('[api/reminder] SMS sent', { sid: message.sid, to: maskPhone(clientPhone), bookingUid });
    return res.status(200).json({ ok: true, smsSid: message.sid });
  } catch (err) {
    console.error('[api/reminder] Twilio send failed:', {
      bookingUid,
      to: maskPhone(clientPhone),
      code: err && err.code,
      status: err && err.status,
      message: err && err.message
    });
    return res.status(200).json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};
