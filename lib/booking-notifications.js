/**
 * Confirmation SMS + Resend confirmation email (when a real address exists) +
 * QStash 24h/1h reminder scheduling for confirmed bookings.
 * Called after checkout confirm (and admin manual-booking complete) — not on
 * the early Cal BOOKING_CREATED webhook, so abandoned holds never get SMS.
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');
const { parseClientPhone } = require('./client-phone.js');
const { isOutboundSmsAllowed } = require('./outbound-sms-allowed.js');
const {
  buildConfirmationSms,
  resolveConfirmationSms,
  resolveAdminCancelSms,
  resolveNoShowNoChargeSms,
  resolveNoShowChargedSms,
  resolveRescheduleSms,
  resolveLateCancelFeeSms,
  resolveNoShowFreePassUsedSms,
  resolveLateChangeFreePassUsedSms,
  resolveNoShowFreePassGrantedSms,
  resolveLateChangeFreePassGrantedSms,
  resolveConsentRequestSms,
  resolveClientCancelEarlySms,
  resolveClientCancelLateNoFeeSms,
  resolveCheckoutAbandonedSms,
  resolveFeedbackDayAfterSms,
} = require('./sms-appointment-copy.js');
const {
  isPlaceholderClientEmail,
  isValidEmail,
} = require('./client-email.js');
const { sqlPhoneVariants } = require('./client-phone.js');

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
  'https://www.sadiemarie.co'
).replace(/\/$/, '');
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
    return { clientId: null, hasConsented: true, firstName: null };
  }
  const trimmed = clientId.trim();
  if (!trimmed) {
    return { clientId: null, hasConsented: true, firstName: null };
  }

  try {
    const { rows } = await sql`
      SELECT id, has_consented, first_name
      FROM clients
      WHERE id = ${trimmed}::uuid
      LIMIT 1
    `;
    if (!rows[0]) {
      console.warn('[booking-notifications] client not found for consent check', {
        clientId: trimmed,
      });
      return { clientId: trimmed, hasConsented: true, firstName: null };
    }
    return {
      clientId: rows[0].id,
      hasConsented: Boolean(rows[0].has_consented),
      firstName:
        typeof rows[0].first_name === 'string' ? rows[0].first_name : null,
    };
  } catch (err) {
    console.error('[booking-notifications] consent lookup failed', {
      clientId: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return { clientId: trimmed, hasConsented: true, firstName: null };
  }
}

async function resolveClientConsentByPhone(clientPhone) {
  const [pv0, pv1] = sqlPhoneVariants(clientPhone || '');
  if (!pv0 && !pv1) {
    return { clientId: null, hasConsented: true, firstName: null };
  }
  try {
    const { rows } = await sql`
      SELECT id, has_consented, first_name
      FROM clients
      WHERE phone = ${pv0} OR phone = ${pv1}
      LIMIT 1
    `;
    if (!rows[0]) {
      return { clientId: null, hasConsented: true, firstName: null };
    }
    return {
      clientId: rows[0].id,
      hasConsented: Boolean(rows[0].has_consented),
      firstName:
        typeof rows[0].first_name === 'string' ? rows[0].first_name : null,
    };
  } catch (err) {
    console.error('[booking-notifications] consent phone lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { clientId: null, hasConsented: true, firstName: null };
  }
}

function consentFormAbsoluteUrl(clientId) {
  if (!clientId || typeof clientId !== 'string') return null;
  const id = clientId.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return null;
  }
  return `${PUBLIC_BASE_URL}/consent/${id}`;
}

function firstNameFromClientName(clientName) {
  if (typeof clientName !== 'string') return '';
  const part = clientName.trim().split(/\s+/)[0];
  return part || '';
}

async function claimConsentSmsSend(bookingUid) {
  if (!bookingUid) return true;
  const key = `${bookingUid}:consent-sms`;
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${key})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[booking-notifications] consent SMS claim failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Separate consent outreach after booking confirm.
 * SMS only with sms-consent opt-in; email whenever a real address exists.
 * Skipped when this phone/client already has has_consented.
 */
async function notifyConsentRequestIfNeeded({
  bookingUid,
  clientId = null,
  clientPhone,
  clientName,
  clientEmail = null,
  smsOptIn = undefined,
}) {
  const byId = clientId
    ? await loadClientConsent(clientId)
    : { clientId: null, hasConsented: true, firstName: null };
  const consent =
    byId.clientId != null
      ? byId
      : await resolveClientConsentByPhone(clientPhone);

  if (!consent.clientId || consent.hasConsented) {
    return {
      ok: true,
      skipped: consent.hasConsented ? 'already_consented' : 'no_client',
    };
  }

  const consentUrl = consentFormAbsoluteUrl(consent.clientId);
  if (!consentUrl) {
    return { ok: false, skipped: 'invalid_consent_url' };
  }

  const firstName =
    consent.firstName || firstNameFromClientName(clientName) || '';
  const result = {
    ok: true,
    clientId: consent.clientId,
    consentUrl,
    sms: null,
    email: null,
  };

  const allowSms = smsOptIn !== false && smsOptIn !== 'false' && smsOptIn !== 0;
  if (allowSms) {
    if (!(await isOutboundSmsAllowed())) {
      result.sms = { ok: true, skipped: 'outbound_sms_disabled' };
    } else {
      const claimed = await claimConsentSmsSend(bookingUid);
      if (!claimed) {
        result.sms = { ok: true, skipped: 'already_sent' };
      } else {
        result.sms = await sendTransactionalSms({
          clientPhone,
          body: await resolveConsentRequestSms({ firstName, consentUrl }),
          bookingUid,
          smsOptIn: true,
          logLabel: 'consent_request',
        });
      }
    }
  } else {
    result.sms = { ok: true, skipped: 'sms_opt_in_false' };
  }

  const email =
    typeof clientEmail === 'string' ? clientEmail.trim().toLowerCase() : '';
  if (email && isValidEmail(email) && !isPlaceholderClientEmail(email)) {
    try {
      const mod = await import('./send-consent-request-email');
      result.email = await mod.sendConsentRequestEmail({
        clientName: clientName || firstName || '',
        clientEmail: email,
        consentUrl,
        bookingUid,
      });
    } catch (err) {
      console.error('[booking-notifications] consent email failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
      result.email = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    result.email = { ok: true, skipped: 'no_email' };
  }

  return result;
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

/**
 * Resend booking confirmation when we have a real client email.
 * Independent of SMS opt-in — email-only bookings still get this.
 */
async function sendBookingConfirmationEmailIfNeeded({
  bookingUid,
  bookingTime,
  clientName,
  serviceName,
  clientEmail,
}) {
  const email =
    typeof clientEmail === 'string' ? clientEmail.trim().toLowerCase() : '';
  if (!email || !isValidEmail(email) || isPlaceholderClientEmail(email)) {
    return { ok: true, skipped: 'no_email' };
  }
  if (!bookingTime) {
    return { ok: true, skipped: 'no_booking_time' };
  }

  const startTime =
    bookingTime instanceof Date ? bookingTime.toISOString() : String(bookingTime);
  const cancelUrl = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;

  try {
    const mod = await import('./send-booking-confirmation-email');
    return await mod.sendBookingConfirmationEmail({
      clientName: clientName || '',
      clientEmail: email,
      serviceName: serviceName || 'appointment',
      startTime,
      cancelUrl,
      bookingUid,
    });
  } catch (err) {
    console.error('[booking-notifications] confirmation email failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

async function scheduleReminderAndFeedback(
  bookingUid,
  bookingTime,
  { serviceName = null, endTime = null } = {}
) {
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

  // Match email lead timing: brows/Teeth Whitening → 48h, lashes → 24h.
  let leadKind = '24h';
  let leadOffsetMs = 24 * 60 * 60 * 1000;
  if (serviceName) {
    try {
      const lookup = await import('./appointment-service-lookup');
      const resolved = await lookup.resolveAppointmentService(
        serviceName,
        bookingTime,
        endTime
      );
      const reminderKind =
        resolved.reminderKind ??
        lookup.inferReminderKindFromServiceName(serviceName);
      if (reminderKind === 'brows') {
        leadKind = '48h';
        leadOffsetMs = 48 * 60 * 60 * 1000;
      } else if (reminderKind === 'lashes') {
        leadKind = '24h';
        leadOffsetMs = 24 * 60 * 60 * 1000;
      }
    } catch (err) {
      console.warn(
        '[booking-notifications] SMS lead kind lookup failed — defaulting to 24h',
        {
          bookingUid,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const reminderLeadAt = Math.floor((appointmentMs - leadOffsetMs) / 1000);
  const reminder1hAt = Math.floor((appointmentMs - 60 * 60 * 1000) / 1000);

  const out = {
    scheduled: true,
    leadKind,
    reminderLead: null,
    // Back-compat aliases for callers/logs that still expect these keys.
    reminder24h: null,
    reminder48h: null,
    reminder1h: null,
    feedback: null,
  };

  if (reminderLeadAt > nowSec) {
    try {
      const reminderRes = await qstash.publishJSON({
        url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/remind`,
        body: { bookingUid, kind: leadKind },
        notBefore: reminderLeadAt,
      });
      const id = reminderRes?.messageId ?? true;
      out.reminderLead = id;
      if (leadKind === '48h') out.reminder48h = id;
      else out.reminder24h = id;
    } catch (err) {
      console.error(
        `[booking-notifications] qstash ${leadKind} reminder failed`,
        {
          bookingUid,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  } else {
    out.reminderLead = 'skipped_too_soon';
    if (leadKind === '48h') out.reminder48h = 'skipped_too_soon';
    else out.reminder24h = 'skipped_too_soon';
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

  // Day-after thank-you (~24h after appointment end / start).
  const feedbackAt = Math.floor((appointmentMs + 24 * 60 * 60 * 1000) / 1000);
  if (feedbackAt > nowSec) {
    try {
      const feedbackRes = await qstash.publishJSON({
        url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/feedback`,
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
  } else {
    out.feedback = 'skipped_too_soon';
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
    let consentOutreach = null;
    try {
      consentOutreach = await notifyConsentRequestIfNeeded({
        bookingUid,
        clientId,
        clientPhone,
        clientName,
        clientEmail,
        smsOptIn,
      });
    } catch (err) {
      consentOutreach = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, skipped: 'already_notified', consentOutreach };
  }

  const reminderEmails = await scheduleAppointmentReminderEmailsForBooking({
    bookingUid,
    bookingTime,
    serviceName,
    clientEmail,
    endTime,
  });

  let confirmationEmail = null;
  try {
    confirmationEmail = await sendBookingConfirmationEmailIfNeeded({
      bookingUid,
      bookingTime,
      clientName,
      serviceName,
      clientEmail,
    });
  } catch (err) {
    confirmationEmail = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  /** Always after confirmation SMS (or after we know SMS will not send). */
  async function runConsentOutreach() {
    try {
      return await notifyConsentRequestIfNeeded({
        bookingUid,
        clientId,
        clientPhone,
        clientName,
        clientEmail,
        smsOptIn,
      });
    } catch (err) {
      console.error('[booking-notifications] consent outreach failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

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
    const consentOutreach = await runConsentOutreach();
    return {
      ok: true,
      skipped: 'sms_opt_in_false',
      qstash: { skipped: 'sms_opt_in_false' },
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  }

  const qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime, {
    serviceName,
    endTime,
  });

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
    const consentOutreach = await runConsentOutreach();
    return {
      ok: true,
      skipped: 'no_phone',
      qstash,
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[booking-notifications] Twilio env missing', { bookingUid });
    const consentOutreach = await runConsentOutreach();
    return {
      ok: true,
      skipped: 'twilio_not_configured',
      qstash,
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  }

  if (!(await isOutboundSmsAllowed())) {
    console.warn('[booking-notifications] SMS skipped (non-production / staging)', {
      bookingUid,
    });
    const consentOutreach = await runConsentOutreach();
    return {
      ok: true,
      skipped: 'outbound_sms_disabled',
      qstash,
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const manageUrl = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: await resolveConfirmationSms({
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

    // Consent after confirmation so the manage/confirm text lands first.
    const consentOutreach = await runConsentOutreach();

    return {
      ok: true,
      smsSid: message.sid,
      qstash,
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  } catch (err) {
    console.error('[booking-notifications] Twilio send failed', {
      bookingUid,
      to: maskPhone(to),
      message: err instanceof Error ? err.message : String(err),
    });
    const consentOutreach = await runConsentOutreach();
    return {
      ok: false,
      smsError: err instanceof Error ? err.message : String(err),
      qstash,
      reminderEmails,
      confirmationEmail,
      consentOutreach,
    };
  }
}

/**
 * Low-level Twilio send. Never throws.
 * A2P: requires smsOptIn === true.
 */
async function sendTransactionalSms({
  clientPhone,
  body,
  bookingUid = null,
  smsOptIn,
  logLabel = 'transactional',
}) {
  if (smsOptIn !== true) {
    return { ok: true, skipped: 'sms_opt_in_false' };
  }

  const to = phoneForTwilio(clientPhone);
  if (!to) {
    return { ok: true, skipped: 'no_phone' };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } =
    process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error(`[booking-notifications] Twilio env missing (${logLabel})`, {
      bookingUid,
    });
    return { ok: true, skipped: 'twilio_not_configured' };
  }

  if (!(await isOutboundSmsAllowed())) {
    console.warn(
      `[booking-notifications] ${logLabel} SMS skipped (non-production / staging)`,
      { bookingUid }
    );
    return { ok: true, skipped: 'outbound_sms_disabled' };
  }

  if (!body || typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'empty_body' };
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: body.trim(),
    });
    console.log(`[booking-notifications] ${logLabel} SMS sent`, {
      bookingUid,
      sid: message.sid,
      to: maskPhone(to),
    });
    return { ok: true, smsSid: message.sid };
  } catch (err) {
    console.error(`[booking-notifications] ${logLabel} SMS failed`, {
      bookingUid,
      to: maskPhone(to),
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Admin cancel / no-show lifecycle texts. Non-blocking for callers.
 */
async function notifyAdminAppointmentStatusSms({
  kind,
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
  amountCents = null,
}) {
  let body;
  if (kind === 'admin_cancel') {
    body = await resolveAdminCancelSms({ serviceName, bookingTime });
  } else if (kind === 'no_show_charged') {
    body = await resolveNoShowChargedSms({
      serviceName,
      bookingTime,
      amountCents,
    });
  } else if (kind === 'no_show') {
    body = await resolveNoShowNoChargeSms({ serviceName, bookingTime });
  } else {
    return { ok: false, error: 'unknown_kind' };
  }

  return sendTransactionalSms({
    clientPhone,
    body,
    bookingUid,
    smsOptIn,
    logLabel: kind,
  });
}

/**
 * Reschedule SMS + re-queue 24h/1h SMS reminders for the new UID/time.
 * Idempotent via webhook_events key `{uid}:reschedule_sms`.
 */
async function notifyAppointmentRescheduled({
  bookingUid,
  bookingTime,
  clientPhone,
  serviceName,
  smsOptIn,
  scheduleSmsReminders = true,
}) {
  if (!bookingUid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  const dedupeKey = `${bookingUid}:reschedule_sms`;
  let claimed = false;
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${dedupeKey})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    claimed = rows.length > 0;
  } catch (err) {
    console.warn('[booking-notifications] reschedule SMS claim failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    claimed = true;
  }

  let sms = { ok: true, skipped: 'already_notified' };
  if (claimed) {
    const manageUrl = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(bookingUid)}`;
    sms = await sendTransactionalSms({
      clientPhone,
      body: await resolveRescheduleSms({
        serviceName,
        bookingTime,
        manageUrl,
      }),
      bookingUid,
      smsOptIn,
      logLabel: 'reschedule',
    });
  }

  let qstash = { skipped: 'not_requested' };
  if (scheduleSmsReminders && smsOptIn === true && bookingTime) {
    qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime, {
      serviceName,
    });
  }

  return { ok: true, sms, qstash, claimed };
}

/**
 * Late-cancel fee receipt SMS (after successful Stripe charge).
 */
async function notifyLateCancelFeeSms({
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
  amountCents = null,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveLateCancelFeeSms({
      serviceName,
      bookingTime,
      amountCents,
    }),
    bookingUid,
    smsOptIn,
    logLabel: 'late_cancel_fee',
  });
}

async function notifyClientCancelEarlySms({
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveClientCancelEarlySms({ serviceName, bookingTime }),
    bookingUid,
    smsOptIn,
    logLabel: 'client_cancel_early',
  });
}

async function notifyClientCancelLateNoFeeSms({
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveClientCancelLateNoFeeSms({ serviceName, bookingTime }),
    bookingUid,
    smsOptIn,
    logLabel: 'client_cancel_late_no_fee',
  });
}

async function notifyCheckoutAbandonedSms({
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveCheckoutAbandonedSms({ serviceName, bookingTime }),
    bookingUid,
    smsOptIn,
    logLabel: 'checkout_abandoned',
  });
}

async function notifyFeedbackDayAfterSms({
  clientPhone,
  smsOptIn,
  firstName,
  serviceName,
  bookingUid = null,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveFeedbackDayAfterSms({ firstName, serviceName }),
    bookingUid,
    smsOptIn,
    logLabel: 'feedback_day_after',
  });
}

/**
 * Free-pass used / granted SMS (no-show and late-change).
 * @param {'no_show_free_pass_used'|'late_change_free_pass_used'|'no_show_free_pass_granted'|'late_change_free_pass_granted'} kind
 */
async function notifyFeeFreePassSms({
  kind,
  clientPhone,
  smsOptIn,
  serviceName = null,
  bookingTime = null,
  bookingUid = null,
}) {
  let body;
  if (kind === 'no_show_free_pass_used') {
    body = await resolveNoShowFreePassUsedSms({ serviceName, bookingTime });
  } else if (kind === 'late_change_free_pass_used') {
    body = await resolveLateChangeFreePassUsedSms({ serviceName, bookingTime });
  } else if (kind === 'no_show_free_pass_granted') {
    body = await resolveNoShowFreePassGrantedSms({ serviceName, bookingTime });
  } else if (kind === 'late_change_free_pass_granted') {
    body = await resolveLateChangeFreePassGrantedSms({
      serviceName,
      bookingTime,
    });
  } else {
    return { ok: false, error: 'unknown_kind' };
  }

  return sendTransactionalSms({
    clientPhone,
    body,
    bookingUid,
    smsOptIn,
    logLabel: kind,
  });
}

module.exports = {
  buildConfirmationMessage,
  phoneForTwilio,
  notifyBookingConfirmed,
  scheduleReminderAndFeedback,
  scheduleAppointmentReminderEmailsForBooking,
  rescheduleAppointmentReminderEmails,
  loadClientConsent,
  notifyConsentRequestIfNeeded,
  sendTransactionalSms,
  notifyAdminAppointmentStatusSms,
  notifyAppointmentRescheduled,
  notifyLateCancelFeeSms,
  notifyClientCancelEarlySms,
  notifyClientCancelLateNoFeeSms,
  notifyCheckoutAbandonedSms,
  notifyFeedbackDayAfterSms,
  notifyFeeFreePassSms,
};
