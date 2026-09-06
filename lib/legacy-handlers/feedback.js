/**
 * POST /api/feedback
 *
 * Legacy QStash day-after thank-you. New bookings no longer schedule this
 * URL — post-visit SMS goes through /api/qstash/review-request at end+30m.
 * Leftover jobs still send thank-you-only if the post-visit text has not
 * already gone out (so visits that missed the old 30-minute skip still get
 * one thank-you). Always 200 on logical skips so QStash does not retry.
 */

const { sql } = require('@vercel/postgres');
const { Receiver } = require('@upstash/qstash');
const {
  notifyFeedbackDayAfterSms,
  hasPostVisitSmsSend,
  claimPostVisitSmsSend,
  releasePostVisitSmsSend,
} = require('../booking-notifications.js');
const { bookingTimesMatch, isSmsOptInTruthy } = require('../sms-reminder-guards');

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
    console.error('[api/feedback] failed to read body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'body_read_failed' });
  }

  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY) {
    console.error(
      '[api/feedback] QSTASH_CURRENT_SIGNING_KEY missing — refusing to process'
    );
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
    console.warn(
      '[api/feedback] signature verification threw:',
      err && err.message
    );
    return res.status(401).json({ error: 'invalid_signature' });
  }

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

  let appointment;
  try {
    const { rows } = await sql`
      SELECT cal_event_id, status, client_first_name, client_phone,
             service_name, cal_event_type_id, sms_opt_in, booking_time
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
    console.warn('[api/feedback] appointment not found — skipping', {
      bookingUid,
    });
    return res.status(200).json({ ok: true, skipped: 'not_found' });
  }

  if (appointment.status && appointment.status !== 'confirmed') {
    console.log('[api/feedback] appointment not confirmed — skipping', {
      bookingUid,
      status: appointment.status,
    });
    return res.status(200).json({ ok: true, skipped: 'status_not_confirmed' });
  }

  // Reschedule idempotency: skip jobs queued for a previous booking time —
  // the reschedule flow queued a fresh follow-up for the new time.
  const expectedBookingTime =
    body && typeof body.expectedBookingTime === 'string'
      ? body.expectedBookingTime
      : null;
  if (expectedBookingTime && appointment.booking_time) {
    if (!bookingTimesMatch(expectedBookingTime, appointment.booking_time)) {
      console.log('[api/feedback] booking time changed — skipping stale job', {
        bookingUid,
        expectedBookingTime,
        actualBookingTime:
          appointment.booking_time instanceof Date
            ? appointment.booking_time.toISOString()
            : String(appointment.booking_time),
      });
      return res
        .status(200)
        .json({ ok: true, skipped: 'booking_time_changed' });
    }
  }

  if (!isSmsOptInTruthy(appointment.sms_opt_in)) {
    console.log('[api/feedback] sms_opt_in not true — skipping', { bookingUid });
    return res.status(200).json({ ok: true, skipped: 'sms_opt_in_false' });
  }

  if (await hasPostVisitSmsSend(bookingUid)) {
    return res.status(200).json({ ok: true, skipped: 'already_sent' });
  }

  const claimed = await claimPostVisitSmsSend(bookingUid);
  if (!claimed) {
    return res.status(200).json({ ok: true, skipped: 'already_sent' });
  }

  try {
    const lookup = await import('../appointment-service-lookup');
    const serviceName = await lookup.smsServiceDisplayName(
      appointment.service_name,
      {
        bookingTime: appointment.booking_time,
        calEventTypeId: appointment.cal_event_type_id,
      }
    );
    const result = await notifyFeedbackDayAfterSms({
      clientPhone: appointment.client_phone,
      smsOptIn: true,
      firstName: appointment.client_first_name,
      serviceName,
      bookingUid,
      claimOnce: false,
    });
    if (!result || result.ok === false || result.skipped || !result.smsSid) {
      await releasePostVisitSmsSend(bookingUid);
      return res.status(200).json({
        ok: true,
        skipped: result?.skipped || 'send_failed',
        sms: result,
      });
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    await releasePostVisitSmsSend(bookingUid);
    console.error('[api/feedback] send failed:', {
      bookingUid,
      message: err && err.message,
    });
    return res
      .status(200)
      .json({ ok: true, smsError: (err && err.message) || 'unknown' });
  }
};

module.exports.config = { api: { bodyParser: false } };
