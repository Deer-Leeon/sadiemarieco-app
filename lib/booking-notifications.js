/**
 * Confirmation SMS + Resend confirmation email (when a real address exists) +
 * QStash 48h/24h reminder scheduling for confirmed bookings.
 * Called after checkout confirm (and admin manual-booking complete) — not on
 * the early Cal BOOKING_CREATED webhook, so abandoned holds never get SMS.
 */

const twilio = require('twilio');
const { sql } = require('@vercel/postgres');
const { Client: QStashClient } = require('@upstash/qstash');
const { parseClientPhone } = require('./client-phone.js');
const { isOutboundSmsAllowed } = require('./outbound-sms-allowed.js');
const { isSmsOptInTruthy, bookingTimesMatch } = require('./sms-reminder-guards');
const { recordOutboundSms } = require('./sms-outbound-log');
const {
  buildConfirmationSms,
  resolveConfirmationSms,
  resolveVisitConfirmationSms,
  resolveVisitUpdateSms,
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
  resolveReviewRequestSms,
  resolveReviewRequestManualSms,
} = require('./sms-appointment-copy.js');
const {
  isPlaceholderClientEmail,
  isValidEmail,
} = require('./client-email.js');
const { sqlPhoneVariants } = require('./client-phone.js');
const visitSms = require('./same-day-visit.js');

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

async function catalogueSmsServiceName(
  serviceName,
  { bookingTime = null, endTime = null, calEventTypeId = null } = {}
) {
  try {
    const lookup = await import('./appointment-service-lookup');
    return await lookup.smsServiceDisplayName(serviceName, {
      bookingTime,
      endTime,
      calEventTypeId,
    });
  } catch (err) {
    console.warn(
      '[booking-notifications] catalogue SMS label lookup failed',
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return serviceName || 'appointment';
  }
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
  const rescheduleKey = `${bookingUid}:reschedule_sms`;
  const { rows } = await sql`
    SELECT 1 FROM webhook_events
    WHERE booking_uid = ${bookingUid}
       OR booking_uid = ${rescheduleKey}
    LIMIT 1
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

function skipClientSmsClaimKey(calUid) {
  return `${calUid}:skip_client_sms`;
}

async function claimSkipClientSms(calUid) {
  if (!calUid) return false;
  const key = skipClientSmsClaimKey(calUid);
  await sql`
    INSERT INTO webhook_events (booking_uid)
    VALUES (${key})
    ON CONFLICT (booking_uid) DO NOTHING
  `;
  return true;
}

async function releaseSkipClientSms(calUid) {
  if (!calUid) return;
  const key = skipClientSmsClaimKey(calUid);
  await sql`DELETE FROM webhook_events WHERE booking_uid = ${key}`;
}

async function hasSkipClientSms(calUid) {
  if (!calUid) return false;
  const key = skipClientSmsClaimKey(calUid);
  const { rows } = await sql`
    SELECT 1 FROM webhook_events WHERE booking_uid = ${key} LIMIT 1
  `;
  return rows.length > 0;
}

const REVIEW_REQUEST_DELAY_MS = 30 * 60 * 1000;

function qstashSmsClaimKey(bookingUid, kind) {
  return `${bookingUid}:qstash_sms:${kind}`;
}

function isoFromSqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function reviewRequestFireAtMs(endTime, bookingTime) {
  const endMs = Date.parse(String(endTime || ''));
  if (Number.isFinite(endMs)) return endMs + REVIEW_REQUEST_DELAY_MS;
  const startMs = Date.parse(String(bookingTime || ''));
  if (Number.isFinite(startMs)) return startMs + REVIEW_REQUEST_DELAY_MS;
  return null;
}

async function loadAppointmentTimes(bookingUid) {
  const { rows } = await sql`
    SELECT booking_time, end_time
    FROM appointments
    WHERE cal_event_id = ${bookingUid}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { bookingTime: null, endTime: null };
  return {
    bookingTime: isoFromSqlDate(row.booking_time),
    endTime: isoFromSqlDate(row.end_time),
  };
}

/**
 * Queue the post-visit SMS for ~30 minutes after the visit ends.
 * Send-time copy depends on “Ask after next visit”: combined thank-you +
 * review ask when on, thank-you only when off.
 *
 * @param {string} bookingUid
 * @param {{ bookingTime?: string | null, endTime?: string | null, force?: boolean }} [opts]
 */
async function scheduleReviewRequestSms(
  bookingUid,
  { bookingTime = null, endTime = null, force = false, catchUp = false } = {}
) {
  if (!bookingUid) {
    return { scheduled: false, reason: 'missing_uid' };
  }

  let startIso = bookingTime ? isoFromSqlDate(bookingTime) || String(bookingTime) : null;
  let endIso = endTime ? isoFromSqlDate(endTime) || String(endTime) : null;
  if (!startIso || !endIso) {
    const loaded = await loadAppointmentTimes(bookingUid);
    startIso = startIso || loaded.bookingTime;
    endIso = endIso || loaded.endTime;
  }

  const fireMs = reviewRequestFireAtMs(endIso, startIso);
  if (!Number.isFinite(fireMs)) {
    return { scheduled: false, reason: 'invalid_time' };
  }

  const qstash = createQStashClient();
  if (!qstash) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const nowMs = Date.now();
  let fireAt = fireMs;
  if (fireAt <= nowMs) {
    if (!catchUp) {
      return { scheduled: false, reason: 'skipped_too_soon' };
    }
    fireAt = nowMs + 2000;
  }

  const expectedBookingTime = startIso
    ? new Date(startIso).toISOString()
    : new Date(fireMs - REVIEW_REQUEST_DELAY_MS).toISOString();
  const claimKey = qstashSmsClaimKey(bookingUid, 'review_request');
  if (force) {
    await releaseWebhookEventClaim(claimKey);
  }
  const claimed = await tryClaimWebhookEvent(claimKey);
  if (!claimed) {
    return { scheduled: false, reason: 'already_scheduled' };
  }

  try {
    const res = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/qstash/review-request`,
      body: { bookingUid, expectedBookingTime },
      notBefore: Math.floor(fireAt / 1000),
    });
    return {
      scheduled: true,
      messageId: res?.messageId ?? true,
      notBefore: Math.floor(fireAt / 1000),
    };
  } catch (err) {
    await releaseWebhookEventClaim(claimKey);
    console.error('[booking-notifications] qstash review_request failed', {
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
 * When an admin re-checks “ask after next visit”, attach the job to the
 * soonest confirmed appointment whose end+30m is still in the future.
 */
async function scheduleReviewRequestForClient(clientId) {
  if (!clientId) {
    return { scheduled: false, reason: 'missing_client' };
  }
  const { rows } = await sql`
    SELECT cal_event_id, booking_time, end_time
    FROM appointments
    WHERE client_id = ${clientId}::uuid
      AND LOWER(COALESCE(status, '')) = 'confirmed'
      AND cal_event_id IS NOT NULL
      AND TRIM(cal_event_id) <> ''
      AND COALESCE(end_time, booking_time) + INTERVAL '30 minutes' > NOW()
    ORDER BY booking_time ASC NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return { scheduled: false, reason: 'no_upcoming_visit' };
  }
  return scheduleReviewRequestSms(String(row.cal_event_id).trim(), {
    bookingTime: isoFromSqlDate(row.booking_time),
    endTime: isoFromSqlDate(row.end_time),
    force: true,
  });
}

async function notifyReviewRequestSms({
  clientPhone,
  smsOptIn,
  firstName,
  serviceName,
  bookingUid = null,
  calEventTypeId = null,
  bookingTime = null,
  endTime = null,
}) {
  serviceName = await catalogueSmsServiceName(serviceName, {
    calEventTypeId,
    bookingTime,
    endTime,
  });
  return sendTransactionalSms({
    clientPhone,
    body: await resolveReviewRequestSms({ firstName, serviceName }),
    bookingUid,
    smsOptIn,
    logLabel: 'review_request',
  });
}

/**
 * QStash callback: send the post-visit SMS ~30 minutes after a confirmed
 * visit. Thank-you always (if opted in); Google review ask only when
 * “Ask after next visit” is still on. That toggle turns off after a
 * successful review-ask send.
 */
async function fulfillReviewRequestForBooking({ bookingUid, expectedBookingTime }) {
  if (!bookingUid) {
    return { ok: true, skipped: 'no_uid' };
  }

  let appointment;
  try {
    const { rows } = await sql`
      SELECT
        a.cal_event_id,
        a.status,
        a.client_first_name,
        a.client_phone,
        a.service_name,
        a.cal_event_type_id,
        a.sms_opt_in,
        a.booking_time,
        a.client_id,
        c.review_request_pending
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.cal_event_id = ${bookingUid}
      LIMIT 1
    `;
    appointment = rows[0];
  } catch (err) {
    console.error('[review-request] appointment lookup failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, skipped: 'db_lookup_failed' };
  }

  if (!appointment) {
    return { ok: true, skipped: 'not_found' };
  }

  if (appointment.status && String(appointment.status).toLowerCase() !== 'confirmed') {
    return { ok: true, skipped: 'status_not_confirmed' };
  }

  if (expectedBookingTime && appointment.booking_time) {
    if (!bookingTimesMatch(expectedBookingTime, appointment.booking_time)) {
      return { ok: true, skipped: 'booking_time_changed' };
    }
  }

  if (!isSmsOptInTruthy(appointment.sms_opt_in)) {
    return { ok: true, skipped: 'sms_opt_in_false' };
  }

  const dayVisit = await visitSms.loadVisitForBookingUid(bookingUid, {
    remainingOnly: false,
  });
  if (dayVisit && dayVisit.services.length) {
    if (dayVisit.lastUid && dayVisit.lastUid !== bookingUid) {
      return { ok: true, skipped: 'not_last_same_day_service' };
    }
    if (await visitSms.hasVisitThankYouSent(dayVisit)) {
      return { ok: true, skipped: 'visit_already_sent' };
    }
  }

  const includeReview = isSmsOptInTruthy(appointment.review_request_pending);
  const claimed = await claimPostVisitSmsSend(bookingUid);
  if (!claimed) {
    return { ok: true, skipped: 'already_sent' };
  }

  try {
    const result = includeReview
      ? await notifyReviewRequestSms({
          clientPhone: appointment.client_phone,
          smsOptIn: true,
          firstName: appointment.client_first_name,
          serviceName: appointment.service_name,
          bookingUid,
          calEventTypeId: appointment.cal_event_type_id,
          bookingTime: appointment.booking_time,
        })
      : await notifyFeedbackDayAfterSms({
          clientPhone: appointment.client_phone,
          smsOptIn: true,
          firstName: appointment.client_first_name,
          serviceName: appointment.service_name,
          bookingUid,
          claimOnce: false,
        });
    if (!result || result.ok === false || result.skipped || !result.smsSid) {
      await releasePostVisitSmsSend(bookingUid);
      return { ok: true, skipped: result?.skipped || 'send_failed', sms: result };
    }
    if (includeReview && appointment.client_id) {
      await sql`
        UPDATE clients
        SET
          review_request_pending = FALSE,
          review_request_last_sent_at = NOW()
        WHERE id = ${appointment.client_id}::uuid
          AND review_request_pending = TRUE
      `;
    }
    if (dayVisit) {
      await visitSms.markVisitThankYouSent(dayVisit, bookingUid);
    }
    return { ok: true, includeReview, ...result };
  } catch (err) {
    await releasePostVisitSmsSend(bookingUid);
    console.error('[review-request] send failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: true,
      skipped: 'send_threw',
      smsError: err instanceof Error ? err.message : String(err),
    };
  }
}

function postVisitSendClaimKeys(bookingUid) {
  return [
    `${bookingUid}:sms_sent:review_request`,
    `${bookingUid}:sms_sent:feedback`,
  ];
}

async function webhookEventExists(key) {
  try {
    const { rows } = await sql`
      SELECT 1 FROM webhook_events WHERE booking_uid = ${key} LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn('[booking-notifications] webhook_events lookup failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function hasPostVisitSmsSend(bookingUid) {
  if (!bookingUid) return false;
  for (const key of postVisitSendClaimKeys(bookingUid)) {
    if (await webhookEventExists(key)) return true;
  }
  return false;
}

async function claimPostVisitSmsSend(bookingUid) {
  if (!bookingUid) return false;
  if (await hasPostVisitSmsSend(bookingUid)) return false;
  const [reviewKey, feedbackKey] = postVisitSendClaimKeys(bookingUid);
  const claimed = await tryClaimWebhookEvent(reviewKey);
  if (!claimed) return false;
  await tryClaimWebhookEvent(feedbackKey);
  return true;
}

async function releasePostVisitSmsSend(bookingUid) {
  if (!bookingUid) return;
  for (const key of postVisitSendClaimKeys(bookingUid)) {
    await releaseWebhookEventClaim(key);
  }
}

async function tryClaimWebhookEvent(key) {
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${key})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn('[booking-notifications] webhook_events claim failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function releaseWebhookEventClaim(key) {
  try {
    await sql`DELETE FROM webhook_events WHERE booking_uid = ${key}`;
  } catch (err) {
    console.warn('[booking-notifications] webhook_events release failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function clearSmsReminderScheduleClaims(bookingUid) {
  if (!bookingUid) return;
  const keys = [
    qstashSmsClaimKey(bookingUid, 'lead'),
    qstashSmsClaimKey(bookingUid, '1h'),
    qstashSmsClaimKey(bookingUid, 'feedback'),
    qstashSmsClaimKey(bookingUid, 'review_request'),
    `${bookingUid}:sms_sent:lead`,
    `${bookingUid}:sms_sent:1h`,
    `${bookingUid}:sms_sent:review_request`,
    `${bookingUid}:sms_sent:feedback`,
  ];
  for (const key of keys) {
    await releaseWebhookEventClaim(key);
  }
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
  calEventTypeId = null,
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
      calEventTypeId,
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
        cal_event_type_id,
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
      calEventTypeId: row.cal_event_type_id,
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
  if (!(await isOutboundSmsAllowed())) {
    return { scheduled: false, reason: 'outbound_sms_disabled' };
  }

  if (!bookingTime) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const qstash = createQStashClient();
  if (!qstash) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }

  const visit = await visitSms.loadVisitForBookingUid(bookingUid);
  if (!visit || !visit.services.length) {
    return { scheduled: false, reason: 'no_remaining_visit' };
  }

  return rebuildVisitJobs(visit, qstash);
}

async function rebuildVisitJobs(visit, qstashClient = null) {
  const qstash = qstashClient || createQStashClient();
  if (!qstash) {
    return { scheduled: false, reason: 'qstash_or_time_missing' };
  }
  if (!visit?.canonicalUid || !visit.arrivalTime) {
    return { scheduled: false, reason: 'no_remaining_visit' };
  }

  const arrivalMs = new Date(visit.arrivalTime).getTime();
  if (!Number.isFinite(arrivalMs)) {
    return { scheduled: false, reason: 'invalid_booking_time' };
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reminderLeadAt = Math.floor((arrivalMs - visit.leadOffsetMs) / 1000);
  const expectedBookingTime = new Date(arrivalMs).toISOString();
  const remindUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/remind`;
  const leadKind = visit.leadKind;
  const bookingUid = visit.canonicalUid;

  const out = {
    scheduled: true,
    leadKind,
    reminderLead: null,
    reminder24h: null,
    reminder48h: null,
    reminder1h: null,
    feedback: null,
    reviewRequest: null,
    visitKey: visit.key,
    visitFingerprint: visit.fingerprint,
  };

  const leadSent = await visitSms.wasVisitLeadSent(visit);
  if (leadSent) {
    out.reminderLead = 'visit_already_sent';
    if (leadKind === '48h') out.reminder48h = out.reminderLead;
    else out.reminder24h = out.reminderLead;
  } else {
    const qstashFpKey = visit.key
      ? `${visit.key}:qstash_lead_fp:${visit.fingerprint}`
      : null;
    const newFp = qstashFpKey
      ? await visitSms.tryClaimWebhookEvent(qstashFpKey)
      : true;
    if (!newFp) {
      out.reminderLead = 'already_scheduled';
    } else {
      for (const service of visit.services) {
        await releaseWebhookEventClaim(qstashSmsClaimKey(service.uid, 'lead'));
      }
      if (visit.key) {
        await visitSms.releaseWebhookEventClaim(
          visitSms.visitQstashLeadKey(visit.key)
        );
      }

      const visitClaimed = visit.key
        ? await visitSms.tryClaimWebhookEvent(
            visitSms.visitQstashLeadKey(visit.key)
          )
        : true;
      const uidClaimed = await tryClaimWebhookEvent(
        qstashSmsClaimKey(bookingUid, 'lead')
      );
      if (!visitClaimed || !uidClaimed) {
        out.reminderLead = 'already_scheduled';
      } else {
        const notBeforeSec =
          reminderLeadAt > nowSec ? reminderLeadAt : nowSec + 2;
        if (arrivalMs <= nowMs) {
          out.reminderLead = 'skipped_too_soon';
          await tryClaimWebhookEvent(`${bookingUid}:sms_sent:lead`);
          if (visit.key) {
            await visitSms.tryClaimWebhookEvent(
              visitSms.visitLeadSentKey(visit.key)
            );
          }
        } else {
          try {
            const reminderRes = await qstash.publishJSON({
              url: remindUrl,
              body: {
                bookingUid,
                kind: leadKind,
                expectedBookingTime,
                visitFingerprint: visit.fingerprint,
              },
              notBefore: notBeforeSec,
            });
            out.reminderLead = reminderRes?.messageId ?? true;
          } catch (err) {
            await releaseWebhookEventClaim(qstashSmsClaimKey(bookingUid, 'lead'));
            if (visit.key) {
              await visitSms.releaseWebhookEventClaim(
                visitSms.visitQstashLeadKey(visit.key)
              );
            }
            if (qstashFpKey) {
              await visitSms.releaseWebhookEventClaim(qstashFpKey);
            }
            console.error(
              `[booking-notifications] qstash ${leadKind} visit reminder failed`,
              {
                bookingUid,
                error: err instanceof Error ? err.message : String(err),
              }
            );
            out.reminderLead = null;
          }
        }
      }
    }
    if (leadKind === '48h') out.reminder48h = out.reminderLead;
    else out.reminder24h = out.reminderLead;
  }

  const thankYouSent = await visitSms.hasVisitThankYouSent(visit);
  if (thankYouSent) {
    out.reviewRequest = 'visit_already_sent';
  } else {
    const reviewFpKey = visit.key
      ? `${visit.key}:qstash_review_fp:${visit.lastUid}:${visit.lastEndTime || ''}`
      : null;
    const newReviewFp = reviewFpKey
      ? await visitSms.tryClaimWebhookEvent(reviewFpKey)
      : true;
    if (!newReviewFp) {
      out.reviewRequest = 'already_scheduled';
    } else {
      for (const service of visit.services) {
        if (service.uid !== visit.lastUid) {
          await releaseWebhookEventClaim(
            qstashSmsClaimKey(service.uid, 'review_request')
          );
        }
      }
      const lastService = visit.services.find((s) => s.uid === visit.lastUid);
      const lastEnded = lastService
        ? Date.parse(lastService.endTime || lastService.bookingTime || '')
        : NaN;
      const catchUp =
        Number.isFinite(lastEnded) && lastEnded + REVIEW_REQUEST_DELAY_MS <= nowMs;
      const reviewResult = await scheduleReviewRequestSms(visit.lastUid, {
        bookingTime: lastService ? lastService.bookingTime : visit.arrivalTime,
        endTime: visit.lastEndTime,
        force: true,
        catchUp,
      });
      out.reviewRequest = reviewResult.scheduled
        ? reviewResult.messageId ?? true
        : reviewResult.reason;
      if (!reviewResult.scheduled && reviewFpKey) {
        await visitSms.releaseWebhookEventClaim(reviewFpKey);
      }
    }
  }
  out.feedback = 'retired_use_post_visit';

  return out;
}

async function sendVisitUpdateSms(visit, { bookingUid = null } = {}) {
  if (!visit?.services?.length) {
    return { ok: true, skipped: 'empty_visit' };
  }
  const already = await visitSms.wasVisitFingerprintNotified(visit);
  if (already) {
    return { ok: true, skipped: 'fingerprint_already_notified' };
  }
  const uid = bookingUid || visit.canonicalUid;
  const manageUrl = uid
    ? `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(uid)}`
    : '';
  const vars = visitSms.visitCopyVars(visit, { manageUrl });
  const body = await resolveVisitUpdateSms(vars);
  const result = await sendTransactionalSms({
    clientPhone: visit.clientPhone,
    body,
    bookingUid: bookingUid || visit.canonicalUid,
    smsOptIn: visit.smsOptIn,
    logLabel: 'visit_update',
  });
  if (result && result.ok !== false && !result.skipped && result.smsSid) {
    await visitSms.markVisitFingerprintNotified(visit);
    await visitSms.markMultiVisitNotified(visit);
    if (await visitSms.wasVisitLeadSent(visit)) {
      await visitSms.markVisitLeadSent(visit, visit.canonicalUid);
    }
  }
  return result;
}

/**
 * After cancel/reschedule: if the remaining visit no longer matches what
 * we already told the client, send a visit update and rebuild jobs.
 */
async function syncVisitNotificationsAfterChange(
  bookingUid,
  { skipSingleIfIsThisBooking = false } = {}
) {
  if (!bookingUid) return { ok: true, skipped: 'missing_uid' };
  const uids = await visitSms.listUpcomingVisitCanonicalUids(bookingUid);
  if (!uids.includes(bookingUid)) uids.unshift(bookingUid);
  const results = [];
  const seenVisitKeys = new Set();
  for (const uid of uids) {
    const visit = await visitSms.loadVisitForBookingUid(uid);
    if (!visit || !visit.services.length) continue;
    if (visit.key && seenVisitKeys.has(visit.key)) continue;
    if (visit.key) seenVisitKeys.add(visit.key);
    const leadSent = await visitSms.wasVisitLeadSent(visit);
    const thisFpNotified = await visitSms.wasVisitFingerprintNotified(visit);
    const priorNotice = await visitHadPriorNotice(visit);
    let update = { skipped: 'not_needed' };
    if (!thisFpNotified && (leadSent || priorNotice)) {
      const isThisSingle =
        skipSingleIfIsThisBooking &&
        visit.services.length === 1 &&
        visit.services[0].uid === bookingUid;
      if (!isThisSingle) {
        update = await sendVisitUpdateSms(visit, { bookingUid: uid });
      }
    }
    const qstash = await rebuildVisitJobs(visit);
    results.push({ uid, update, qstash, visitKey: visit.key });
  }
  if (!results.length) {
    return { ok: true, skipped: 'no_remaining_visit' };
  }
  return { ok: true, visits: results };
}

async function visitHadPriorNotice(visit) {
  if (!visit?.key) return false;
  try {
    return await visitSms.wasMultiVisitNotified(visit);
  } catch (err) {
    return false;
  }
}

async function pickVisitConfirmationBody({
  visit,
  serviceName,
  bookingTime,
  manageUrl,
}) {
  const vars = visitSms.visitCopyVars(visit, { serviceName, manageUrl });
  if (!visit || visit.services.length <= 1) {
    return {
      body: await resolveConfirmationSms({
        serviceName,
        bookingTime,
        manageUrl,
      }),
      logLabel: 'confirmation',
    };
  }
  const leadSent = await visitSms.wasVisitLeadSent(visit);
  const thisFpNotified = await visitSms.wasVisitFingerprintNotified(visit);
  if (thisFpNotified) {
    return { body: null, logLabel: 'confirmation', skipped: 'fingerprint_already_notified' };
  }
  // Prep lives on the pre-visit reminder. An add-on booking before that
  // reminder is a confirmation, not a "visit update".
  if (leadSent) {
    return {
      body: await resolveVisitUpdateSms(vars),
      logLabel: 'visit_update',
    };
  }
  return {
    body: await resolveVisitConfirmationSms(vars),
    logLabel: 'confirmation_visit',
  };
}

/**
 * Re-publish missing reminder and post-visit (end+30m) jobs for upcoming
 * (and in-progress) confirmed, SMS-opted-in appointments.
 * Safe to run every 15 minutes — QStash claims are idempotent.
 */
async function ensureUpcomingAppointmentSmsReminders() {
  const { rows } = await sql`
    SELECT
      cal_event_id,
      service_name,
      booking_time,
      end_time
    FROM appointments
    WHERE LOWER(COALESCE(status, '')) = 'confirmed'
      AND cal_event_id IS NOT NULL
      AND TRIM(cal_event_id) <> ''
      AND client_phone IS NOT NULL
      AND TRIM(client_phone) <> ''
      AND booking_time > NOW()
      AND booking_time < NOW() + INTERVAL '60 days'
      AND (
        sms_opt_in IS TRUE
        OR LOWER(TRIM(sms_opt_in::text)) IN ('t', 'true', '1', 'yes')
      )
    ORDER BY booking_time ASC
    LIMIT 150
  `;

  let scheduled = 0;
  const failures = [];
  for (const row of rows) {
    const bookingUid = String(row.cal_event_id || '').trim();
    if (!bookingUid) continue;
    const bookingTime =
      row.booking_time instanceof Date
        ? row.booking_time.toISOString()
        : row.booking_time
          ? String(row.booking_time)
          : null;
    const endTime =
      row.end_time instanceof Date
        ? row.end_time.toISOString()
        : row.end_time
          ? String(row.end_time)
          : null;
    try {
      const result = await scheduleReminderAndFeedback(bookingUid, bookingTime, {
        serviceName: row.service_name,
        endTime,
      });
      if (
        result &&
        result.scheduled &&
        (result.reminderLead || result.reviewRequest)
      ) {
        scheduled += 1;
      }
    } catch (err) {
      failures.push({
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('[booking-notifications] ensure reminders failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { rows: reviewRows } = await sql`
    SELECT
      a.cal_event_id,
      a.booking_time,
      a.end_time
    FROM appointments a
    WHERE LOWER(COALESCE(a.status, '')) = 'confirmed'
      AND a.cal_event_id IS NOT NULL
      AND TRIM(a.cal_event_id) <> ''
      AND a.client_phone IS NOT NULL
      AND TRIM(a.client_phone) <> ''
      AND (
        a.sms_opt_in IS TRUE
        OR LOWER(TRIM(a.sms_opt_in::text)) IN ('t', 'true', '1', 'yes')
      )
      AND COALESCE(a.end_time, a.booking_time) + INTERVAL '30 minutes' > NOW()
      AND COALESCE(a.end_time, a.booking_time) < NOW() + INTERVAL '60 days'
    ORDER BY a.booking_time ASC NULLS LAST
    LIMIT 80
  `;

  for (const row of reviewRows) {
    const bookingUid = String(row.cal_event_id || '').trim();
    if (!bookingUid) continue;
    try {
      const result = await scheduleReviewRequestSms(bookingUid, {
        bookingTime: isoFromSqlDate(row.booking_time),
        endTime: isoFromSqlDate(row.end_time),
      });
      if (result && result.scheduled) scheduled += 1;
    } catch (err) {
      failures.push({
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('[booking-notifications] ensure review_request failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: rows.length + reviewRows.length,
    scheduled,
    failed: failures.length,
    failures: failures.slice(0, 10),
  };
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
  // 'admin' = staff booked this for the client (different iOS push copy).
  source = 'client',
}) {
  if (!bookingUid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  serviceName = await catalogueSmsServiceName(serviceName, {
    bookingTime,
    endTime,
  });

  let adminPush = null;
  try {
    const { notifyAdminAppointmentPush } = require('./admin-booking-push');
    adminPush = await notifyAdminAppointmentPush({
      kind: 'confirmed',
      source: source === 'admin' ? 'admin' : 'client',
      bookingUid,
      bookingTime,
      clientName,
      serviceName,
    });
  } catch (err) {
    console.error(
      '[booking-notifications] admin iOS push failed (non-blocking)',
      {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    adminPush = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (skipIfAlreadySent && (await wasBookingNotificationSent(bookingUid))) {
    let qstash = { skipped: 'already_notified' };
    const allowSms =
      smsOptIn !== false && smsOptIn !== 'false' && smsOptIn !== 0;
    if (allowSms) {
      qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime, {
        serviceName,
        endTime,
      });
    }
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
    return {
      ok: true,
      skipped: 'already_notified',
      qstash,
      consentOutreach,
      adminPush,
    };
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
    const visit = await visitSms.loadVisitForBookingUid(bookingUid);
    const picked = await pickVisitConfirmationBody({
      visit,
      serviceName,
      bookingTime,
      manageUrl,
    });
    if (picked.skipped) {
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
        skipped: picked.skipped,
        qstash,
        reminderEmails,
        confirmationEmail,
        consentOutreach,
      };
    }
    let smsBody = picked.body;
    try {
      const { rows: payRows } = await sql`
        SELECT payment_timing
        FROM appointments
        WHERE cal_event_id = ${bookingUid}
        LIMIT 1
      `;
      const timing = String(payRows[0]?.payment_timing || '').trim();
      if (
        (picked.logLabel === 'confirmation' ||
          picked.logLabel === 'confirmation_visit') &&
        timing === 'pay_now'
      ) {
        smsBody = `${smsBody} Paid in full online.`;
      } else if (
        (picked.logLabel === 'confirmation' ||
          picked.logLabel === 'confirmation_visit') &&
        timing === 'pay_later'
      ) {
        smsBody = `${smsBody} Balance due at your visit.`;
      }
    } catch (payErr) {
      console.warn('[booking-notifications] payment_timing lookup failed (non-fatal)', {
        bookingUid,
        error: payErr instanceof Error ? payErr.message : String(payErr),
      });
    }
    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body: smsBody,
    });
    console.log('[booking-notifications] confirmation SMS sent', {
      bookingUid,
      sid: message.sid,
      to: maskPhone(to),
    });
    void recordOutboundSms({
      logLabel: picked.logLabel || 'confirmation',
      body: smsBody,
      toE164: to,
      bookingUid,
      twilioSid: message.sid,
    });

    try {
      await markBookingNotificationSent(bookingUid);
    } catch (dbErr) {
      console.error('[booking-notifications] webhook_events insert failed', {
        bookingUid,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    if (visit) {
      await visitSms.markVisitFingerprintNotified(visit);
      if (
        picked.logLabel === 'confirmation_visit' ||
        picked.logLabel === 'visit_update'
      ) {
        await visitSms.markMultiVisitNotified(visit);
      }
      if (picked.logLabel === 'visit_update') {
        await visitSms.markVisitLeadSent(visit, visit.canonicalUid);
      }
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
  sendOnceKey = null,
}) {
  if (!isSmsOptInTruthy(smsOptIn)) {
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

  const claimKey =
    typeof sendOnceKey === 'string' && sendOnceKey.trim()
      ? sendOnceKey.trim()
      : null;
  if (claimKey) {
    const claimed = await tryClaimWebhookEvent(claimKey);
    if (!claimed) {
      console.log(`[booking-notifications] ${logLabel} already sent — skip`, {
        bookingUid,
      });
      return { ok: true, skipped: 'already_sent' };
    }
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
    void recordOutboundSms({
      logLabel,
      body: body.trim(),
      toE164: to,
      bookingUid,
      twilioSid: message.sid,
    });
    return { ok: true, smsSid: message.sid };
  } catch (err) {
    if (claimKey) {
      await releaseWebhookEventClaim(claimKey);
    }
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
  serviceName = await catalogueSmsServiceName(serviceName, { bookingTime });
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

  const statusSms = await sendTransactionalSms({
    clientPhone,
    body,
    bookingUid,
    smsOptIn,
    logLabel: kind,
  });
  if (kind === 'admin_cancel' && bookingUid) {
    try {
      await syncVisitNotificationsAfterChange(bookingUid);
    } catch (err) {
      console.warn('[booking-notifications] visit sync after admin cancel failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return statusSms;
}

/**
 * Reschedule SMS + re-queue 48h/24h SMS reminders for the new UID/time.
 * Idempotent via webhook_events key `{uid}:reschedule_sms`. Also marks
 * `{uid}` so a later BOOKING_CREATED cannot send confirmation SMS.
 */
async function notifyAppointmentRescheduled({
  bookingUid,
  bookingTime,
  clientPhone,
  serviceName,
  smsOptIn,
  scheduleSmsReminders = true,
  endTime = null,
  source = 'client',
  clientName = '',
  appointmentId = null,
  sendClientSms = true,
  requestHost = null,
}) {
  if (!bookingUid) {
    return { ok: false, skipped: 'missing_booking_uid' };
  }

  serviceName = await catalogueSmsServiceName(serviceName, {
    bookingTime,
    endTime,
  });

  let adminPush = null;
  try {
    const { notifyAdminAppointmentPush } = require('./admin-booking-push');
    adminPush = await notifyAdminAppointmentPush({
      kind: 'rescheduled',
      source: source === 'admin' ? 'admin' : 'client',
      bookingUid,
      bookingTime,
      clientName,
      serviceName,
      appointmentId,
      requestHost,
    });
  } catch (err) {
    console.error(
      '[booking-notifications] admin iOS reschedule push failed (non-blocking)',
      {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    adminPush = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
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

  try {
    await markBookingNotificationSent(bookingUid);
  } catch (err) {
    console.warn('[booking-notifications] confirmation claim after reschedule failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let sms = { ok: true, skipped: 'already_notified' };
  if (claimed) {
    if (sendClientSms === false) {
      sms = { ok: true, skipped: 'admin_send_sms_false' };
    } else {
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
  }

  let qstash = { skipped: 'not_requested' };
  if (scheduleSmsReminders && isSmsOptInTruthy(smsOptIn) && bookingTime) {
    await clearSmsReminderScheduleClaims(bookingUid);
    qstash = await scheduleReminderAndFeedback(bookingUid, bookingTime, {
      serviceName,
      endTime,
    });
    try {
      await syncVisitNotificationsAfterChange(bookingUid, {
        skipSingleIfIsThisBooking: true,
      });
    } catch (syncErr) {
      console.warn('[booking-notifications] visit sync after reschedule failed', {
        bookingUid,
        error: syncErr instanceof Error ? syncErr.message : String(syncErr),
      });
    }
  }

  return { ok: true, sms, qstash, claimed, adminPush };
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
  const result = await sendTransactionalSms({
    clientPhone,
    body: await resolveClientCancelEarlySms({ serviceName, bookingTime }),
    bookingUid,
    smsOptIn,
    logLabel: 'client_cancel_early',
  });
  try {
    await syncVisitNotificationsAfterChange(bookingUid);
  } catch (err) {
    console.warn('[booking-notifications] visit sync after cancel failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

async function notifyClientCancelLateNoFeeSms({
  clientPhone,
  smsOptIn,
  serviceName,
  bookingTime,
  bookingUid = null,
}) {
  const result = await sendTransactionalSms({
    clientPhone,
    body: await resolveClientCancelLateNoFeeSms({ serviceName, bookingTime }),
    bookingUid,
    smsOptIn,
    logLabel: 'client_cancel_late_no_fee',
  });
  try {
    await syncVisitNotificationsAfterChange(bookingUid);
  } catch (err) {
    console.warn('[booking-notifications] visit sync after late cancel failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
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
  claimOnce = true,
}) {
  return sendTransactionalSms({
    clientPhone,
    body: await resolveFeedbackDayAfterSms({ firstName, serviceName }),
    bookingUid,
    smsOptIn,
    logLabel: 'feedback_day_after',
    sendOnceKey:
      claimOnce && bookingUid ? `${bookingUid}:sms_sent:feedback` : null,
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
  serviceName = await catalogueSmsServiceName(serviceName, { bookingTime });
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

const MANUAL_SMS_SKIP_MESSAGES = Object.freeze({
  not_found: 'Client not found.',
  no_phone: 'This client has no phone number on file.',
  sms_opt_in_false:
    "This client hasn't opted in to texts on a booking.",
  outbound_sms_disabled: 'Outbound texts are turned off.',
  invalid_consent_url: 'Could not build the consent form link.',
  unknown_kind: 'Unknown text type.',
  twilio_not_configured: 'Twilio is not configured.',
  already_consented: 'This client has already signed the consent form.',
  already_reviewed: 'This client already has a Google review recorded.',
});

/**
 * Admin-triggered consent / Google-review SMS from the client profile.
 * Skips booking-level already-sent claims so staff can send again on purpose.
 * Still requires a phone, outbound SMS allowed, and at least one sms_opt_in
 * appointment (A2P).
 */
async function sendManualClientSms({ clientId, kind }) {
  if (kind !== 'consent_request' && kind !== 'review_request') {
    return { ok: false, error: 'unknown_kind' };
  }
  if (!clientId) {
    return { ok: true, skipped: 'not_found' };
  }

  const { rows: clientRows } = await sql`
    SELECT
      id::text AS id,
      phone,
      first_name,
      last_name,
      has_consented,
      google_review_stars
    FROM clients
    WHERE id = ${clientId}::uuid
    LIMIT 1
  `;
  const client = clientRows[0];
  if (!client) {
    return { ok: true, skipped: 'not_found' };
  }

  if (kind === 'consent_request' && client.has_consented === true) {
    return { ok: true, skipped: 'already_consented' };
  }
  const recordedStars = Number(client.google_review_stars);
  if (
    kind === 'review_request' &&
    Number.isFinite(recordedStars) &&
    recordedStars >= 1
  ) {
    return { ok: true, skipped: 'already_reviewed' };
  }

  if (!(await isOutboundSmsAllowed())) {
    return { ok: true, skipped: 'outbound_sms_disabled' };
  }

  if (!phoneForTwilio(client.phone)) {
    return { ok: true, skipped: 'no_phone' };
  }

  const { rows: apptRows } = await sql`
    SELECT 1
    FROM appointments
    WHERE client_id = ${clientId}::uuid
      AND sms_opt_in IS TRUE
    LIMIT 1
  `;
  if (!apptRows[0]) {
    return { ok: true, skipped: 'sms_opt_in_false' };
  }

  const firstName =
    firstNameFromClientName(
      [client.first_name, client.last_name]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ')
    ) || '';

  if (kind === 'consent_request') {
    const consentUrl = consentFormAbsoluteUrl(client.id);
    if (!consentUrl) {
      return { ok: false, skipped: 'invalid_consent_url' };
    }
    const sms = await sendTransactionalSms({
      clientPhone: client.phone,
      body: await resolveConsentRequestSms({ firstName, consentUrl }),
      bookingUid: null,
      smsOptIn: true,
      logLabel: 'consent_request',
    });
    return { ok: sms.ok !== false, kind, ...sms };
  }

  const sms = await sendTransactionalSms({
    clientPhone: client.phone,
    body: await resolveReviewRequestManualSms({ firstName }),
    bookingUid: null,
    smsOptIn: true,
    logLabel: 'review_request_manual',
  });
  if (sms && sms.ok !== false && !sms.skipped && sms.smsSid) {
    await sql`
      UPDATE clients
      SET
        review_request_pending = FALSE,
        review_request_last_sent_at = NOW()
      WHERE id = ${clientId}::uuid
    `;
  }
  return { ok: sms.ok !== false, kind, ...sms };
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
  claimSkipClientSms,
  releaseSkipClientSms,
  hasSkipClientSms,
  skipClientSmsClaimKey,
  notifyLateCancelFeeSms,
  notifyClientCancelEarlySms,
  notifyClientCancelLateNoFeeSms,
  notifyCheckoutAbandonedSms,
  notifyFeedbackDayAfterSms,
  notifyReviewRequestSms,
  notifyFeeFreePassSms,
  ensureUpcomingAppointmentSmsReminders,
  scheduleReviewRequestSms,
  scheduleReviewRequestForClient,
  fulfillReviewRequestForBooking,
  syncVisitNotificationsAfterChange,
  hasPostVisitSmsSend,
  claimPostVisitSmsSend,
  releasePostVisitSmsSend,
  sendManualClientSms,
  MANUAL_SMS_SKIP_MESSAGES,
};
