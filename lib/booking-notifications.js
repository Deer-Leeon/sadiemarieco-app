/**
 * Confirmation SMS + QStash reminder/feedback scheduling for confirmed bookings.
 * Used by the Cal webhook (BOOKING_CREATED) and admin manual-booking complete.
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');
const { parseClientPhone } = require('./client-phone.js');

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://sadiemarieco.vercel.app';
const MANAGE_LINK_BASE = `${PUBLIC_BASE_URL}/manage.html`;

// Keep in sync with lib/legacy-handlers/webhook.js
const GOOGLE_VOICE_NUMBER = '[Insert Your Google Voice Number Here]';
const FOOTER_NOTE = `(Note: This is an automated line. To reach the studio directly, please call or text ${GOOGLE_VOICE_NUMBER}).`;

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
}

function buildConfirmationMessage({ clientName, serviceName, bookingUid }) {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  const name = clientName && String(clientName).trim() ? String(clientName).trim() : 'there';
  const service =
    serviceName && String(serviceName).trim() ? String(serviceName).trim() : 'appointment';
  return `Hi ${name}! 🤍 Your ${service} at Sadie Marie is confirmed. To view policies, reschedule, or cancel, use your secure link: ${link}\n\n${FOOTER_NOTE}`;
}

/** E.164 for Twilio from stored digits or raw Cal input. */
function phoneForTwilio(raw) {
  const parsed = parseClientPhone(raw);
  if (parsed) return parsed.e164;
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+')) return raw.trim();
  return null;
}

async function wasBookingNotificationSent(bookingUid) {
  const { rows } = await sql`
    SELECT 1 FROM webhook_events WHERE booking_uid = ${bookingUid} LIMIT 1
  `;
  return rows.length > 0;
}

async function markBookingNotificationSent(bookingUid) {
  await sql`
    INSERT INTO webhook_events (booking_uid)
    VALUES (${bookingUid})
    ON CONFLICT (booking_uid) DO NOTHING
  `;
}

async function scheduleReminderAndFeedback(bookingUid, bookingTime) {
  if (!process.env.QSTASH_TOKEN || !bookingTime) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const appointmentMs = new Date(bookingTime).getTime();
  if (!Number.isFinite(appointmentMs)) {
    return { scheduled: false, reason: 'invalid_booking_time' };
  }

  const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN });
  const reminderAt = Math.floor((appointmentMs - 24 * 60 * 60 * 1000) / 1000);
  const feedbackAt = Math.floor((appointmentMs + 24 * 60 * 60 * 1000) / 1000);

  const out = { scheduled: true, reminder: null, feedback: null };

  try {
    const reminderRes = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL}/api/remind`,
      body: { bookingUid },
      notBefore: reminderAt,
    });
    out.reminder = reminderRes?.messageId ?? true;
  } catch (err) {
    console.error('[booking-notifications] qstash reminder failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const feedbackRes = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL}/api/feedback`,
      body: { bookingUid },
      notBefore: feedbackAt,
    });
    out.feedback = feedbackRes?.messageId ?? true;
  } catch (err) {
    console.error('[booking-notifications] qstash feedback failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return out;
}

/**
 * Send confirmation SMS + schedule reminder/feedback. Idempotent per booking_uid.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function notifyBookingConfirmed({
  bookingUid,
  bookingTime,
  clientPhone,
  clientName,
  serviceName,
  skipIfAlreadySent = true,
}) {
  if (!bookingUid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  if (skipIfAlreadySent && (await wasBookingNotificationSent(bookingUid))) {
    return { ok: true, skipped: 'already_notified' };
  }

  const to = phoneForTwilio(clientPhone);
  if (!to) {
    console.warn('[booking-notifications] no usable phone — skipping SMS', { bookingUid });
    return { ok: true, skipped: 'no_phone' };
  }

  const qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime);

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[booking-notifications] Twilio env missing', { bookingUid });
    return { ok: true, skipped: 'twilio_not_configured', qstash };
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: buildConfirmationMessage({ clientName, serviceName, bookingUid }),
    });
    console.log('[booking-notifications] confirmation SMS sent', {
      bookingUid,
      sid: message.sid,
      to: maskPhone(to),
    });

    try {
      await markBookingNotificationSent(bookingUid);
    } catch (dbErr) {
      console.error('[booking-notifications] webhook_events insert failed', {
        bookingUid,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    return { ok: true, smsSid: message.sid, qstash };
  } catch (err) {
    console.error('[booking-notifications] Twilio send failed', {
      bookingUid,
      to: maskPhone(to),
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      smsError: err instanceof Error ? err.message : String(err),
      qstash,
    };
  }
}

module.exports = {
  buildConfirmationMessage,
  phoneForTwilio,
  notifyBookingConfirmed,
  scheduleReminderAndFeedback,
};
