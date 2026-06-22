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

const CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildConsentFormLink(clientId) {
  if (!clientId) return null;
  const id = String(clientId).trim().toLowerCase();
  if (!CLIENT_UUID_RE.test(id)) return null;
  const base = PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}/consent/${encodeURIComponent(id)}`;
}

/**
 * @param {{ clientName?: string, serviceName?: string, bookingUid: string, clientId?: string | null, hasConsented?: boolean }} opts
 */
function buildConfirmationMessage({
  clientName,
  serviceName,
  bookingUid,
  clientId = null,
  hasConsented = true,
}) {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  const name = clientName && String(clientName).trim() ? String(clientName).trim() : 'there';
  const service =
    serviceName && String(serviceName).trim() ? String(serviceName).trim() : 'appointment';
  let body = `Hi ${name}! 🤍 Your ${service} at Sadie Marie is confirmed. To view policies, reschedule, or cancel, use your secure link: ${link}\n\n${FOOTER_NOTE}`;

  if (!hasConsented && clientId) {
    const consentLink = buildConsentFormLink(clientId);
    if (consentLink) {
      body += `\n\nPlease complete your intake form before your appointment: ${consentLink}`;
    }
  }

  return body;
}

async function loadClientConsent(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    return { clientId: null, hasConsented: true };
  }
  const trimmed = clientId.trim();
  if (!trimmed) {
    return { clientId: null, hasConsented: true };
  }

  try {
    const { rows } = await sql`
      SELECT id, has_consented
      FROM clients
      WHERE id = ${trimmed}::uuid
      LIMIT 1
    `;
    if (!rows[0]) {
      console.warn('[booking-notifications] client not found for consent check', {
        clientId: trimmed,
      });
      return { clientId: trimmed, hasConsented: true };
    }
    return {
      clientId: rows[0].id,
      hasConsented: Boolean(rows[0].has_consented),
    };
  } catch (err) {
    console.error('[booking-notifications] consent lookup failed', {
      clientId: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return { clientId: trimmed, hasConsented: true };
  }
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

async function scheduleAppointmentReminderEmailsForBooking({
  bookingUid,
  bookingTime,
  serviceName,
  clientEmail,
  endTime = null,
}) {
  if (!clientEmail || !bookingTime) {
    return { scheduled: false, reason: 'no_email_or_time' };
  }

  try {
    const mod = await import('./schedule-appointment-reminder-emails');
    return mod.scheduleAppointmentReminderEmails({
      bookingUid,
      bookingTime,
      serviceName,
      clientEmail,
      endTime,
    });
  } catch (err) {
    console.error('[booking-notifications] reminder email schedule failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      scheduled: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Re-queue reminder emails after a reschedule. Old QStash jobs self-skip
 * when booking_time no longer matches their expectedBookingTime payload.
 */
async function rescheduleAppointmentReminderEmails(bookingUid) {
  if (!bookingUid) {
    return { scheduled: false, reason: 'missing_booking_uid' };
  }

  try {
    const { rows } = await sql`
      SELECT
        cal_event_id,
        service_name,
        booking_time,
        end_time,
        client_email,
        status
      FROM appointments
      WHERE cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return { scheduled: false, reason: 'not_found' };
    }
    if (row.status && row.status !== 'confirmed') {
      return { scheduled: false, reason: 'not_confirmed' };
    }
    if (!row.client_email || !row.booking_time) {
      return { scheduled: false, reason: 'no_email_or_time' };
    }

    const bookingTime =
      row.booking_time instanceof Date
        ? row.booking_time.toISOString()
        : String(row.booking_time);
    const endTime =
      row.end_time instanceof Date
        ? row.end_time.toISOString()
        : row.end_time
          ? String(row.end_time)
          : null;

    return scheduleAppointmentReminderEmailsForBooking({
      bookingUid,
      bookingTime,
      serviceName: row.service_name || 'appointment',
      clientEmail: row.client_email,
      endTime,
    });
  } catch (err) {
    console.error('[booking-notifications] reschedule email lookup failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      scheduled: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
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
 * Send confirmation SMS + schedule SMS/email reminders. Idempotent per booking_uid.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function notifyBookingConfirmed({
  bookingUid,
  bookingTime,
  clientPhone,
  clientName,
  serviceName,
  clientId = null,
  clientEmail = null,
  skipIfAlreadySent = true,
  endTime = null,
}) {
  if (!bookingUid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  if (skipIfAlreadySent && (await wasBookingNotificationSent(bookingUid))) {
    return { ok: true, skipped: 'already_notified' };
  }

  const reminderEmails = await scheduleAppointmentReminderEmailsForBooking({
    bookingUid,
    bookingTime,
    serviceName,
    clientEmail,
    endTime,
  });

  const qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime);

  const to = phoneForTwilio(clientPhone);
  if (!to) {
    console.warn('[booking-notifications] no usable phone — skipping SMS', { bookingUid });
    try {
      await markBookingNotificationSent(bookingUid);
    } catch (dbErr) {
      console.error('[booking-notifications] webhook_events insert failed', {
        bookingUid,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    return { ok: true, skipped: 'no_phone', qstash, reminderEmails };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[booking-notifications] Twilio env missing', { bookingUid });
    return { ok: true, skipped: 'twilio_not_configured', qstash, reminderEmails };
  }

  const consent = await loadClientConsent(clientId);

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: buildConfirmationMessage({
        clientName,
        serviceName,
        bookingUid,
        clientId: consent.clientId,
        hasConsented: consent.hasConsented,
      }),
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

    return { ok: true, smsSid: message.sid, qstash, reminderEmails };
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
      reminderEmails,
    };
  }
}

module.exports = {
  buildConfirmationMessage,
  buildConsentFormLink,
  phoneForTwilio,
  notifyBookingConfirmed,
  scheduleReminderAndFeedback,
  scheduleAppointmentReminderEmailsForBooking,
  rescheduleAppointmentReminderEmails,
  loadClientConsent,
};
