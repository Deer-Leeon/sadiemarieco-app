/**
 * Confirmation SMS + QStash 24h/1h reminder scheduling for confirmed bookings.
 * Called after checkout confirm (and admin manual-booking complete) — not on
 * the early Cal BOOKING_CREATED webhook, so abandoned holds never get SMS.
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');
const { parseClientPhone } = require('./client-phone.js');
const {
  buildConfirmationSms,
} = require('./sms-appointment-copy.js');

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://sadiemarieco.vercel.app';
const MANAGE_LINK_BASE = `${PUBLIC_BASE_URL}/manage.html`;
const DEFAULT_QSTASH_URL = 'https://qstash-us-east-1.upstash.io';

function createQStashClient() {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = (process.env.QSTASH_URL?.trim() || DEFAULT_QSTASH_URL).replace(
    /\/$/,
    ''
  );
  return new QStashClient({ token, baseUrl });
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
}

/**
 * @deprecated Prefer buildConfirmationSms from sms-appointment-copy.js
 * Kept as a thin wrapper for any external require() of buildConfirmationMessage.
 */
function buildConfirmationMessage({
  serviceName,
  bookingUid,
  bookingTime = null,
}) {
  const link = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
  return buildConfirmationSms({
    serviceName,
    bookingTime,
    manageUrl: link,
  });
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
  if (!bookingTime) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const appointmentMs = new Date(bookingTime).getTime();
  if (!Number.isFinite(appointmentMs)) {
    return { scheduled: false, reason: 'invalid_booking_time' };
  }

  const qstash = createQStashClient();
  if (!qstash) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const reminder24At = Math.floor((appointmentMs - 24 * 60 * 60 * 1000) / 1000);
  const reminder1hAt = Math.floor((appointmentMs - 60 * 60 * 1000) / 1000);

  const out = {
    scheduled: true,
    reminder24h: null,
    reminder1h: null,
    // Legacy key — day-after thank-you is no longer scheduled (A2P sample set).
    feedback: null,
  };

  if (reminder24At > nowSec) {
    try {
      const reminderRes = await qstash.publishJSON({
        url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/remind`,
        body: { bookingUid, kind: '24h' },
        notBefore: reminder24At,
      });
      out.reminder24h = reminderRes?.messageId ?? true;
    } catch (err) {
      console.error('[booking-notifications] qstash 24h reminder failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    out.reminder24h = 'skipped_too_soon';
  }

  if (reminder1hAt > nowSec) {
    try {
      const reminderRes = await qstash.publishJSON({
        url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/remind`,
        body: { bookingUid, kind: '1h' },
        notBefore: reminder1hAt,
      });
      out.reminder1h = reminderRes?.messageId ?? true;
    } catch (err) {
      console.error('[booking-notifications] qstash 1h reminder failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    out.reminder1h = 'skipped_too_soon';
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
  // Explicit SMS checkbox opt-in. false = skip Twilio SMS + QStash SMS jobs.
  // undefined/null = allow SMS (admin/manual/legacy paths).
  smsOptIn = undefined,
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

  const allowSms = smsOptIn !== false && smsOptIn !== 'false' && smsOptIn !== 0;
  if (!allowSms) {
    console.log('[booking-notifications] SMS skipped — no sms-consent opt-in', {
      bookingUid,
    });
    try {
      await markBookingNotificationSent(bookingUid);
    } catch (dbErr) {
      console.error('[booking-notifications] webhook_events insert failed', {
        bookingUid,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    return {
      ok: true,
      skipped: 'sms_opt_in_false',
      qstash: { skipped: 'sms_opt_in_false' },
      reminderEmails,
    };
  }

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

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const manageUrl = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: buildConfirmationSms({
        serviceName,
        bookingTime,
        manageUrl,
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
  phoneForTwilio,
  notifyBookingConfirmed,
  scheduleReminderAndFeedback,
  scheduleAppointmentReminderEmailsForBooking,
  rescheduleAppointmentReminderEmails,
  loadClientConsent,
};
