/**
 * POST /api/remind-email
 *
 * QStash-triggered handler for pre-appointment reminder emails (48h brows,
 * 24h lashes, and 1h-before for both). Scheduled by booking-notifications
 * at confirmation time with notBefore set to the target send window.
 *
 * Payload: { bookingUid, expectedBookingTime, timing: 'lead' | '1h' }
 * The handler re-reads the appointment row at delivery time and skips when
 * the booking was cancelled or rescheduled (booking_time !== expectedBookingTime).
 */

const { Receiver } = require('@upstash/qstash');

const readRawBody = (req) =>
  new Promise((resolve, reject) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (req.body && typeof req.body === 'object') {
      return resolve(JSON.stringify(req.body));
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[api/remind-email] failed to read body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'body_read_failed' });
  }

  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY) {
    console.error(
      '[api/remind-email] QSTASH_CURRENT_SIGNING_KEY missing — refusing to process',
    );
    return res.status(500).json({ error: 'signing_key_not_configured' });
  }

  const signature = req.headers['upstash-signature'];
  if (!signature) {
    console.warn('[api/remind-email] missing upstash-signature header');
    return res.status(401).json({ error: 'missing_signature' });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      console.warn('[api/remind-email] invalid signature');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  } catch (err) {
    console.warn('[api/remind-email] signature verification threw:', err && err.message);
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch (err) {
    console.error('[api/remind-email] invalid JSON body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  const bookingUid = body && body.bookingUid;
  const expectedBookingTime = body && body.expectedBookingTime;
  const timing = body && body.timing;

  if (!bookingUid || !expectedBookingTime || !timing) {
    console.warn('[api/remind-email] missing required fields', {
      bookingUid,
      timing,
    });
    return res.status(200).json({ ok: true, skipped: 'missing_fields' });
  }

  if (timing !== 'lead' && timing !== '1h') {
    console.warn('[api/remind-email] unknown timing', { timing });
    return res.status(200).json({ ok: true, skipped: 'unknown_timing' });
  }

  try {
    const mod = await import('../send-appointment-reminder-email');
    const result = await mod.deliverScheduledReminderEmail({
      bookingUid,
      expectedBookingTime,
      timing,
    });
    console.log('[api/remind-email] delivery result', { bookingUid, timing, result });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[api/remind-email] delivery failed', {
      bookingUid,
      timing,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(200).json({ ok: true, skipped: 'delivery_failed' });
  }
};

module.exports.config = { api: { bodyParser: false } };
