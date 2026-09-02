/**
 * POST /api/webhook
 *
 * Receives Cal.com webhook events and dispatches on `triggerEvent`:
 *   - BOOKING_REQUESTED  → client + appointment upsert as 'pending' (fires
 *                          when the guest confirms a slot on event types
 *                          that "Require confirmation" — this is the
 *                          handoff moment before /checkout).
 *   - BOOKING_CREATED    → same upsert path; may fire for auto-confirmed
 *                          types or after upstream acceptance. Public
 *                          website SMS + reminder QStash run after checkout
 *                          confirm. Admin manual bookings confirm here and
 *                          queue reminders (complete is a second idempotent
 *                          path). Public pending upserts also schedule a
 *                          delayed /api/qstash/release-hold so abandoned
 *                          holds clear even when /api/booking/init fails.
 *   - BOOKING_CANCELLED  → flip appointments.status to 'cancelled' so the
 *                          scheduled QStash jobs (api/remind, api/feedback)
 *                          see the status gate and skip their SMS.
 *   - BOOKING_RESCHEDULED→ move the existing appointment row to its new
 *                          slot: swap cal_event_id from the OLD UID
 *                          (payload.rescheduleUid) to the NEW UID
 *                          (payload.uid) and overwrite booking_time /
 *                          end_time. Preserves the row's local id +
 *                          client_id (and therefore booking history /
 *                          CRM linkage) instead of creating a duplicate.
 *   - Missing triggerEvent → treated as BOOKING_CREATED (legacy tests).
 *   - Other triggers (MEETING_ENDED, BOOKING_REJECTED, …) → ignored.
 *
 * Always returns 200 OK — even on SMS or DB failure — so Cal won't time out
 * or retry the webhook indefinitely. Errors are logged for our own debugging.
 *
 * Cal.com webhook payload reference:
 *   https://cal.com/docs/core-features/webhooks
 *
 * Required environment variables (set in Vercel → Project Settings → Env Vars):
 *   - CAL_WEBHOOK_SECRET  (must match the secret set on the Cal.com webhook)
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER   (the Twilio number the SMS is sent from)
 *   - POSTGRES_URL          (read by @vercel/postgres automatically)
 *   - QSTASH_TOKEN          (Upstash QStash publish credential)
 *   - PUBLIC_BASE_URL       (optional override; defaults to the prod domain)
 */

const crypto = require('crypto');
const { sql } = require('@vercel/postgres');
const {
  chargeLateCancelFee,
  classifyClientCancelPenalty,
  penaltyAmountCents,
  shouldSkipLateCancelPenalty,
  LATE_CANCEL_FRACTION,
  NO_SHOW_CANCEL_FRACTION,
} = require('../late-cancel-charge');
const {
  isPrepaidPayNowAppointment,
  refundPrepaidBooking,
} = require('../prepaid-booking-refund.js');
const {
  scheduleAbandonedHoldRelease,
} = require('../schedule-abandoned-hold-release.js');

// Cal.com signs the raw HTTP body with HMAC-SHA256 and sends the hex digest
// as X-Cal-Signature-256. We need the exact bytes Cal sent — hence rawBody
// on the App Router wrapper (see app/api/webhook/route.js).
const readRawBody = (req) => new Promise((resolve, reject) => {
  if (typeof req.body === 'string') return resolve(req.body);
  if (req.body && typeof req.body === 'object') {
    return resolve(JSON.stringify(req.body));
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});

function timingSafeEqualString(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function verifyCalWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody || '', 'utf8')
    .digest('hex');
  return timingSafeEqualString(expected, signatureHeader.trim());
}

// Cal.com normally sends application/json. With rawBody: true the adapter
// passes the body as a string; this parses after signature verification.
const parseJsonBody = (raw) => {
  if (!raw) return {};
  return JSON.parse(raw);
};

// Cal sometimes wraps custom field values inside `{ label, value }`.
// Normalize to a plain string regardless of which shape we receive.
const unwrap = (val) => {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.value === 'string') return val.value;
  return String(val);
};

function extractCalEventTypeId(source) {
  if (!source || typeof source !== 'object') return null;
  const metadata =
    source.metadata && typeof source.metadata === 'object'
      ? source.metadata
      : null;
  const nested =
    source.eventType && typeof source.eventType === 'object'
      ? source.eventType
      : null;
  const raw =
    (metadata &&
      (metadata.original_cal_event_id ?? metadata.originalCalEventId)) ??
    source.eventTypeId ??
    (nested && (nested.id ?? nested.eventTypeId)) ??
    null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read the optional `sms-consent` boolean booking field.
 * Returns true / false when present, otherwise undefined.
 */
const parseSmsOptIn = (...sources) => {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const raw =
      src['sms-consent'] ?? src.smsConsent ?? src.sms_consent ?? null;
    if (raw == null) continue;
    const value =
      typeof raw === 'object' && raw !== null && 'value' in raw
        ? raw.value
        : raw;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
    }
  }
  return undefined;
};

// Mask a phone number for log output — keeps the leading country code prefix
// and the last 4 digits, redacts the rest. Avoids dumping full PII into our
// Vercel log aggregator while preserving enough context to trace a failure.
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return '[redacted]';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

// Mask an email for log output — keeps the first character of the local part
// and the full domain so failures can still be cross-referenced with bookings.
const maskEmail = (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '[redacted]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

// Split a Cal-supplied full name into first/last as a fallback when the
// dedicated firstName/lastName fields aren't populated.
const splitName = (fullName) => {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
};

/**
 * Admin manual booking uses a shadow Cal event; real service name + duration
 * live in booking metadata (see /api/admin/manual-booking/create).
 */
const resolveShadowAppointmentFields = (payload) => {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};
  const originalServiceName = unwrap(metadata.original_service_name);
  const durationRaw = unwrap(metadata.original_service_duration_mins);
  const durationMins = durationRaw ? Number(durationRaw) : NaN;
  const isManualAdmin = unwrap(metadata.manual_admin_booking) === 'true';
  const calTitle = unwrap(payload.title) || 'appointment';
  const bookingTime =
    unwrap(payload.startTime) || unwrap(payload.start) || null;
  let endTime = unwrap(payload.endTime) || unwrap(payload.end) || null;
  const serviceName = originalServiceName || calTitle;

  if (
    isManualAdmin &&
    originalServiceName &&
    Number.isFinite(durationMins) &&
    durationMins > 0 &&
    bookingTime
  ) {
    const startMs = new Date(bookingTime).getTime();
    if (!Number.isNaN(startMs)) {
      endTime = new Date(startMs + durationMins * 60_000).toISOString();
    }
  }

  return { serviceName, bookingTime, endTime, isManualAdmin };
};

// Must stay in sync with `isAbandonCancelReason` / contact-channel cancel
// in `lib/booking-hold.ts` + `lib/booking-contact-channel.ts`.
// Cal echoes this string on BOOKING_CANCELLED after our abandoned-checkout
// release. Match any "Checkout abandoned after …" variant so hold-window
// changes (8 min / 10 min / 30 sec) don't break system-cancel labeling.
// Also treat incomplete contact-channel cancels as system (no late fee).
const isSystemAbandonCancellation = (reason) => {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.startsWith('Checkout abandoned after ')) return true;
  if (trimmed === 'Incomplete booking: email or SMS opt-in required.') {
    return true;
  }
  return false;
};

// Event types that should create / refresh a local appointments row.
const APPOINTMENT_CREATION_EVENTS = new Set([
  'BOOKING_REQUESTED',
  'BOOKING_CREATED',
]);

const {
  rescheduleAppointmentReminderEmails,
  notifyAppointmentRescheduled,
  notifyLateCancelFeeSms,
  notifyAdminAppointmentStatusSms,
  notifyFeeFreePassSms,
  notifyClientCancelEarlySms,
  notifyClientCancelLateNoFeeSms,
  notifyBookingConfirmed,
} = require('../booking-notifications.js');
const { extractCalBookingNotes } = require('../cal-booking-notes.js');
const { normaliseClientPhoneForStorage } = require('../client-phone.js');
const { normalizeClientEmailForStorage } = require('../client-email.js');
const {
  recordClientChangeFeeCounters,
  consumeFeeWaiveNext,
  clearFeeWaiveNext,
} = require('../client-change-counters.js');

/**
 * Policy fee for late client cancel/reschedule (based on current booking_time).
 * Charges Stripe when eligible; free-pass waive still bumps counters + status.
 * Idempotent via webhook_events `dedupeKey`.
 *
 * @returns {Promise<null | {
 *   waived?: boolean,
 *   payment_intent_id?: string,
 *   amount_cents?: number,
 *   currency?: string,
 *   fee_type?: string,
 *   penalty_kind: 'late_half' | 'no_show_full',
 * }>}
 */
async function applyClientChangePenaltyFee({
  existing,
  dedupeKey,
  action = 'cancel',
  logPrefix = '[api/webhook]',
}) {
  if (!existing) return null;

  const existingStatus = (existing.status || '').toLowerCase();
  // Include `pending`: clients often reschedule a hold before finishing
  // checkout. Skipping those left the one-time courtesy pass unused even
  // inside the late-change window (charge still requires a vaulted card).
  if (
    existingStatus !== 'confirmed' &&
    existingStatus !== 'canceled_by_client' &&
    existingStatus !== 'pending'
  ) {
    return null;
  }

  const penaltyKind = classifyClientCancelPenalty(existing.booking_time);
  if (penaltyKind === 'none') return null;

  let dedupeClaimed = false;
  const releaseDedupeClaim = async () => {
    if (!dedupeKey || !dedupeClaimed) return;
    try {
      await sql`
        DELETE FROM webhook_events
        WHERE booking_uid = ${dedupeKey}
      `;
      dedupeClaimed = false;
    } catch (releaseErr) {
      console.warn(`${logPrefix}: failed to release change-fee dedupe claim`, {
        dedupeKey,
        error: releaseErr && releaseErr.message,
      });
    }
  };

  if (dedupeKey) {
    try {
      const { rows } = await sql`
        INSERT INTO webhook_events (booking_uid)
        VALUES (${dedupeKey})
        ON CONFLICT (booking_uid) DO NOTHING
        RETURNING booking_uid
      `;
      if (rows.length === 0) {
        console.log(`${logPrefix}: change fee already claimed`, { dedupeKey });
        return null;
      }
      dedupeClaimed = true;
    } catch (dedupeErr) {
      console.warn(`${logPrefix}: change fee dedupe failed — proceeding`, {
        dedupeKey,
        error: dedupeErr && dedupeErr.message,
      });
    }
  }

  const serviceLabel =
    (existing.service_name || 'appointment').split(' between ')[0]?.trim() ||
    'appointment';
  const hasVault =
    typeof existing.stripe_customer_id === 'string' &&
    existing.stripe_customer_id.length > 0;
  const priceRaw =
    existing.service_price === null || existing.service_price === undefined
      ? NaN
      : Number(existing.service_price);
  const fraction =
    penaltyKind === 'no_show_full'
      ? NO_SHOW_CANCEL_FRACTION
      : LATE_CANCEL_FRACTION;
  const amountCents = penaltyAmountCents(priceRaw, fraction);
  const bookingTimeIso =
    existing.booking_time instanceof Date
      ? existing.booking_time.toISOString()
      : existing.booking_time
        ? String(existing.booking_time)
        : null;
  const feeAction = action === 'reschedule' ? 'reschedule' : 'cancel';
  const waiveKind =
    penaltyKind === 'no_show_full' ? 'no_show' : 'late_change';

  // One-time free pass: skip Stripe, still count + consume pass + SMS.
  try {
    const waive = await consumeFeeWaiveNext(
      waiveKind,
      existing.client_id || null,
      existing.client_phone || null
    );
    if (waive.consumed) {
      try {
        await recordClientChangeFeeCounters({
          clientId: waive.clientId || existing.client_id || null,
          clientPhone: existing.client_phone || null,
          action: feeAction,
          penaltyKind,
        });
      } catch (crmErr) {
        console.warn(`${logPrefix}: client counter update failed (non-fatal)`, {
          error: crmErr && crmErr.message,
          penaltyKind,
          action: feeAction,
          waived: true,
        });
      }

      const smsKind =
        penaltyKind === 'no_show_full'
          ? 'no_show_free_pass_used'
          : 'late_change_free_pass_used';
      try {
        await notifyFeeFreePassSms({
          kind: smsKind,
          clientPhone: existing.client_phone,
          smsOptIn: existing.sms_opt_in,
          serviceName: serviceLabel,
          bookingTime: bookingTimeIso,
          bookingUid: existing.cal_event_id || null,
        });
      } catch (smsErr) {
        console.warn(`${logPrefix}: free-pass SMS failed (non-fatal)`, {
          error: smsErr && smsErr.message,
          smsKind,
        });
      }

      console.log(`${logPrefix}: change fee waived (free pass)`, {
        penaltyKind,
        action: feeAction,
        clientId: waive.clientId,
      });
      return { waived: true, penalty_kind: penaltyKind };
    }

    if (!waive.clientId) {
      console.warn(
        `${logPrefix}: penalty window but could not resolve client for free-pass/counters`,
        {
          penaltyKind,
          hasClientId: Boolean(existing.client_id),
          hasPhone: Boolean(existing.client_phone),
        }
      );
      // Don't burn the dedupe key — a later retry (or the paired
      // CANCELLED/RESCHEDULED event) may resolve the client and consume.
      await releaseDedupeClaim();
      return null;
    }
  } catch (waiveErr) {
    console.warn(`${logPrefix}: free-pass check failed — charging if possible`, {
      error: waiveErr && waiveErr.message,
      penaltyKind,
    });
  }

  const prepaid = isPrepaidPayNowAppointment(existing);
  if (!hasVault && !prepaid) {
    console.warn(`${logPrefix}: penalty window but no stripe_customer_id — no fee`, {
      penaltyKind,
      status: existingStatus,
    });
    // Soft-skip: allow a later webhook/retry to apply the free pass or charge.
    await releaseDedupeClaim();
    return null;
  }
  if (amountCents < 50 && !prepaid) {
    console.warn(`${logPrefix}: penalty window but no resolvable service price — no fee`, {
      penaltyKind,
      servicePrice: existing.service_price,
    });
    await releaseDedupeClaim();
    return null;
  }

  const feeType =
    penaltyKind === 'no_show_full' ? 'no_show_penalty' : 'late_cancel_penalty';
  const description =
    penaltyKind === 'no_show_full'
      ? `No-show fee (${Math.round(fraction * 100)}%) — ${serviceLabel}`
      : `Late change fee (${Math.round(fraction * 100)}%) — ${serviceLabel}`;

  try {
    // Pay-now: keep the fee % of the prepaid charge via refund — never
    // create a second off-session PaymentIntent.
    if (prepaid) {
      const refundResult = await refundPrepaidBooking({
        paymentIntentId: existing.stripe_payment_intent_id,
        keepFraction: fraction,
        appointmentId: existing.id,
        calBookingUid: existing.cal_event_id || null,
        reason: description,
        feeType,
      });
      if (!refundResult.ok) {
        console.warn(`${logPrefix}: prepaid policy refund skipped`, {
          penaltyKind,
          error: refundResult.error,
          message: refundResult.message,
        });
        await releaseDedupeClaim();
        return null;
      }

      const charge = {
        payment_intent_id: refundResult.paymentIntentId,
        amount_cents: refundResult.keptAmountCents || 0,
        currency: refundResult.currency || 'usd',
        fee_type: feeType,
        penalty_kind: penaltyKind,
        prepaid_refund: true,
        refund_id: refundResult.refundId || null,
        refund_amount_cents: refundResult.refundAmountCents || 0,
      };

      try {
        await recordClientChangeFeeCounters({
          clientId: existing.client_id || null,
          clientPhone: existing.client_phone || null,
          action: feeAction,
          penaltyKind,
        });
      } catch (crmErr) {
        console.warn(`${logPrefix}: client counter update failed (non-fatal)`, {
          error: crmErr && crmErr.message,
          penaltyKind,
          action: feeAction,
        });
      }

      try {
        await clearFeeWaiveNext(
          waiveKind,
          existing.client_id || null,
          existing.client_phone || null
        );
      } catch (clearErr) {
        console.warn(`${logPrefix}: clear waive_next failed (non-fatal)`, {
          error: clearErr && clearErr.message,
          waiveKind,
        });
      }

      if (penaltyKind === 'no_show_full') {
        try {
          await notifyAdminAppointmentStatusSms({
            kind: 'no_show_charged',
            clientPhone: existing.client_phone,
            smsOptIn: existing.sms_opt_in,
            serviceName: serviceLabel,
            bookingTime: bookingTimeIso,
            bookingUid: existing.cal_event_id || null,
            amountCents: charge.amount_cents,
          });
        } catch (smsErr) {
          console.warn(`${logPrefix}: no-show fee SMS failed (non-fatal)`, {
            error: smsErr && smsErr.message,
          });
        }
      } else {
        try {
          await notifyLateCancelFeeSms({
            clientPhone: existing.client_phone,
            smsOptIn: existing.sms_opt_in,
            serviceName: serviceLabel,
            bookingTime: bookingTimeIso,
            bookingUid: existing.cal_event_id || null,
            amountCents: charge.amount_cents,
          });
        } catch (smsErr) {
          console.warn(`${logPrefix}: late-change fee SMS failed (non-fatal)`, {
            error: smsErr && smsErr.message,
          });
        }
      }

      console.log(`${logPrefix}: prepaid change fee via refund policy`, {
        penaltyKind,
        action: feeAction,
        keptAmountCents: charge.amount_cents,
        refundAmountCents: charge.refund_amount_cents,
      });
      return charge;
    }

    const chargeResult = await chargeLateCancelFee({
      stripeCustomerId: existing.stripe_customer_id,
      appointmentId: existing.id,
      calBookingUid: existing.cal_event_id || null,
      serviceLabel,
      amountCents,
      feeType,
      description,
      penaltyFraction: fraction,
    });
    if (!chargeResult.ok) {
      console.warn(`${logPrefix}: change fee skipped`, {
        penaltyKind,
        error: chargeResult.error,
        message: chargeResult.message,
      });
      await releaseDedupeClaim();
      return null;
    }

    const charge = {
      payment_intent_id: chargeResult.paymentIntentId,
      amount_cents: chargeResult.amountCents,
      currency: chargeResult.currency,
      fee_type: feeType,
      penalty_kind: penaltyKind,
    };

    try {
      await recordClientChangeFeeCounters({
        clientId: existing.client_id || null,
        clientPhone: existing.client_phone || null,
        action: feeAction,
        penaltyKind,
      });
    } catch (crmErr) {
      console.warn(`${logPrefix}: client counter update failed (non-fatal)`, {
        error: crmErr && crmErr.message,
        penaltyKind,
        action: feeAction,
      });
    }

    try {
      await clearFeeWaiveNext(
        waiveKind,
        existing.client_id || null,
        existing.client_phone || null
      );
    } catch (clearErr) {
      console.warn(`${logPrefix}: clear waive_next failed (non-fatal)`, {
        error: clearErr && clearErr.message,
        waiveKind,
      });
    }

    if (penaltyKind === 'no_show_full') {
      try {
        await notifyAdminAppointmentStatusSms({
          kind: 'no_show_charged',
          clientPhone: existing.client_phone,
          smsOptIn: existing.sms_opt_in,
          serviceName: serviceLabel,
          bookingTime: bookingTimeIso,
          bookingUid: existing.cal_event_id || null,
          amountCents: chargeResult.amountCents,
        });
      } catch (smsErr) {
        console.warn(`${logPrefix}: no-show fee SMS failed (non-fatal)`, {
          error: smsErr && smsErr.message,
        });
      }
    } else {
      try {
        await notifyLateCancelFeeSms({
          clientPhone: existing.client_phone,
          smsOptIn: existing.sms_opt_in,
          serviceName: serviceLabel,
          bookingTime: bookingTimeIso,
          bookingUid: existing.cal_event_id || null,
          amountCents: chargeResult.amountCents,
        });
      } catch (smsErr) {
        console.warn(`${logPrefix}: late-change fee SMS failed (non-fatal)`, {
          error: smsErr && smsErr.message,
        });
      }
    }

    console.log(`${logPrefix}: change fee charged`, {
      penaltyKind,
      action: feeAction,
      paymentIntentId: chargeResult.paymentIntentId,
      amountCents: chargeResult.amountCents,
    });
    return charge;
  } catch (chargeErr) {
    console.error(`${logPrefix}: change fee threw`, {
      penaltyKind,
      error: chargeErr && chargeErr.message,
    });
    await releaseDedupeClaim();
    return null;
  }
}

function isRescheduleCancellationReason(reason) {
  const text = String(reason || '')
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('reschedul') ||
    text.includes('re-schedul') ||
    text.includes('moved to a new time') ||
    text.includes('booking was rescheduled')
  );
}

function isRescheduleCancellation(payload, reason) {
  if (isRescheduleCancellationReason(reason)) return true;
  if (!payload || typeof payload !== 'object') return false;
  if (unwrap(payload.rescheduledToUid)) return true;
  if (unwrap(payload.rescheduleUid)) return true;
  if (payload.rescheduled === true) return true;
  return false;
}

/** True when two booking times share the same UTC minute. */
function bookingTimesMatchAtMinute(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const am = Math.floor(new Date(a).getTime() / 60000);
  const bm = Math.floor(new Date(b).getTime() / 60000);
  return Number.isFinite(am) && Number.isFinite(bm) && am === bm;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = (process.env.CAL_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error(
      '[api/webhook] CAL_WEBHOOK_SECRET missing — refusing to process'
    );
    return res.status(503).json({ error: 'webhook_secret_not_configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[api/webhook] failed to read body:', err && err.message);
    return res.status(200).json({ ok: true, skipped: 'body_read_failed' });
  }

  const signature =
    req.headers['x-cal-signature-256'] ||
    req.headers['X-Cal-Signature-256'];
  if (!verifyCalWebhookSignature(rawBody, signature, secret)) {
    console.warn('[api/webhook] invalid or missing X-Cal-Signature-256');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let body;
  try {
    body = parseJsonBody(rawBody);
  } catch (err) {
    console.error('[api/webhook] invalid JSON body:', err);
    // Still 200 — invalid payload isn't worth blocking Cal's queue over.
    return res.status(200).json({ ok: true, skipped: 'invalid_json' });
  }

  // Top-level event type. Cal sends this as a sibling of `payload`. May be
  // absent on hand-rolled test posts; we treat absence as BOOKING_CREATED
  // for backward compat with the original handler shape.
  const triggerEvent = (body && body.triggerEvent) || '';

  const payload = (body && body.payload) || {};
  const attendee = Array.isArray(payload.attendees) && payload.attendees[0] || {};
  const responses = payload.responses || {};

  // Cal.com puts the SMS-reminder number on the attendee record directly
  // (`attendees[0].phoneNumber`). The booking-question response object is a
  // fallback for older payloads where the value lives under
  // `responses.attendeePhoneNumber.value` (custom field wrapper shape).
  const clientName = unwrap(attendee.name) || unwrap(responses.name) || 'there';
  const clientPhone =
    unwrap(attendee.phoneNumber) ||
    unwrap(responses.attendeePhoneNumber) ||
    unwrap(responses.phone);
  const bookingUid = unwrap(payload.uid);

  const {
    serviceName,
    bookingTime,
    endTime,
    isManualAdmin,
  } = resolveShadowAppointmentFields(payload);
  const calEventTypeId = extractCalEventTypeId(payload);
  const bookingNotes = extractCalBookingNotes(payload);

  // Fields needed for the clients + appointments DB upserts.
  const clientEmail = normalizeClientEmailForStorage(
    unwrap(attendee.email) ||
      unwrap(responses.email) ||
      unwrap(responses.attendee_email) ||
      unwrap(responses.email_address)
  );
  const nameFallback = splitName(unwrap(attendee.name));
  const firstName = unwrap(attendee.firstName) || nameFallback.first || '';
  const lastName = unwrap(attendee.lastName) || nameFallback.last || '';

  // Without a UID we can't dedupe or match an appointment record.
  // Client upsert needs a phone and/or a real (non-placeholder) email.
  if (!bookingUid) {
    console.warn('[api/webhook] no booking uid on payload — skipping', { triggerEvent });
    return res.status(200).json({ ok: true, skipped: 'no_uid' });
  }

  const blockMetadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};
  const isAdminTimeBlock = unwrap(blockMetadata.admin_time_block) === 'true';

  if (isAdminTimeBlock) {
    if (triggerEvent === 'BOOKING_CANCELLED') {
      try {
        const { rows: removedRows } = await sql`
          DELETE FROM studio_time_blocks
          WHERE cal_booking_uid = ${bookingUid}
          RETURNING id
        `;
        if (removedRows.length > 0) {
          console.log('[api/webhook] admin time block removed from mirror table', {
            bookingUid,
          });
        }
      } catch (err) {
        console.warn('[api/webhook] admin time block cancel cleanup failed', {
          bookingUid,
          error: err && err.message,
        });
      }
      return res.status(200).json({ ok: true, skipped: 'admin_time_block_cancelled' });
    }

    if (!triggerEvent || APPOINTMENT_CREATION_EVENTS.has(triggerEvent)) {
      console.log('[api/webhook] admin time block — skipping CRM ingest', {
        bookingUid,
        triggerEvent: triggerEvent || 'BOOKING_CREATED',
      });
      return res.status(200).json({ ok: true, skipped: 'admin_time_block' });
    }
  }

  // ── BOOKING_RESCHEDULED BRANCH ──────────────────────────────────────────
  // Cal fires this whenever a booking is moved to a new slot — both for
  // admin-initiated reschedules (which the dashboard also handles
  // synchronously via /api/admin/appointments/<id>/reschedule for instant
  // UI feedback) and for client-initiated ones (the "Reschedule" link in
  // Cal's confirmation email /manage). Without this branch, BOOKING_RESCHEDULED
  // would fall through to the creation flow below and INSERT a duplicate
  // appointment row at the new time while leaving the old one stranded.
  //
  // Strategy: locate the existing row by its OLD UID (Cal sends it as
  // payload.rescheduleUid; we also accept `fromReschedule.uid` defensively
  // because Cal has shipped both shapes historically), optionally charge a
  // late-change fee against the OLD start time (same tiers as cancel), then
  // UPDATE cal_event_id / times. CRM linkage is preserved.
  //
  // Admin reschedules (metadata.admin_reschedule / manual_admin_booking) skip
  // the fee. Client fees are idempotent via webhook_events `{oldUid}:change_fee`.
  //
  // Always returns 200 OK — DB failure must not cause Cal to retry forever.
  if (triggerEvent === 'BOOKING_RESCHEDULED') {
    const oldUid =
      unwrap(payload.rescheduleUid) ||
      unwrap(payload.fromReschedule && payload.fromReschedule.uid) ||
      '';
    if (!oldUid) {
      console.warn(
        '[api/webhook] BOOKING_RESCHEDULED: no rescheduleUid on payload — skipping (avoid duplicate row)',
        { newUid: bookingUid }
      );
      return res
        .status(200)
        .json({ ok: true, skipped: 'reschedule_no_old_uid' });
    }

    const rescheduleMeta =
      payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : {};
    const isAdminReschedule =
      unwrap(rescheduleMeta.admin_reschedule) === 'true' ||
      unwrap(rescheduleMeta.manual_admin_booking) === 'true';

    let changeFee = null;

    // NOTE on status: a reschedule must NEVER promote a row's lifecycle
    // state. If the client rescheduled a still-pending hold (i.e. they
    // never finished the card-vault step at /checkout), the row must
    // stay 'pending' so the cron sweep can release it. We only force
    // back to 'confirmed' when the row was already in an active state
    // (confirmed) or a cancelled-by-* terminal — in which case the
    // reschedule effectively un-cancels and the slot is live again.
    try {
      // Load the pre-move row (OLD booking_time drives the fee window).
      const { rows: existingRows } = await sql`
        SELECT
          a.id,
          a.cal_event_id,
          a.status,
          a.stripe_customer_id,
          a.stripe_payment_intent_id,
          a.payment_timing,
          a.booking_time,
          a.end_time,
          a.service_name,
          a.client_phone,
          a.sms_opt_in,
          a.client_id::text AS client_id,
          a.quoted_service_price_cents::numeric / 100 AS service_price
        FROM appointments a
        LEFT JOIN LATERAL (
          SELECT s.price
          FROM site_services s
          WHERE s.is_active = TRUE
          AND (
            (
              a.cal_event_type_id IS NOT NULL
              AND s.cal_event_id = a.cal_event_type_id
            )
            OR (
              a.cal_event_type_id IS NULL
              AND s.title = split_part(a.service_name, ' between ', 1)
              AND (
                lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
                  'classic', 'hybrid', 'volume'
                )
                OR (
                  a.booking_time IS NOT NULL
                  AND a.end_time IS NOT NULL
                  AND s.duration_mins IS NOT NULL
                  AND s.duration_mins = GREATEST(
                    1,
                    ROUND(
                      EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                    )
                  )::integer
                )
              )
            )
          )
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
        ) s ON TRUE
        WHERE a.cal_event_id = ${oldUid}
        LIMIT 1
      `;
      const existingBefore = existingRows[0] || null;

      const sameSlot = Boolean(
        existingBefore &&
          bookingTimesMatchAtMinute(existingBefore.booking_time, bookingTime)
      );

      if (sameSlot) {
        console.log(
          '[api/webhook] BOOKING_RESCHEDULED: same_slot_noop — skipping change fee',
          { oldUid, newUid: bookingUid, bookingTime }
        );
      } else if (existingBefore && !isAdminReschedule) {
        changeFee = await applyClientChangePenaltyFee({
          existing: existingBefore,
          dedupeKey: `${oldUid}:change_fee`,
          action: 'reschedule',
          logPrefix: '[api/webhook] BOOKING_RESCHEDULED',
        });
      } else if (isAdminReschedule) {
        console.log(
          '[api/webhook] BOOKING_RESCHEDULED: admin reschedule — skipping change fee',
          { oldUid, newUid: bookingUid }
        );
      }

      const { rows: updatedRows } = await sql`
        UPDATE appointments
        SET cal_event_id = ${bookingUid},
            booking_time = ${bookingTime},
            end_time     = ${endTime},
            service_name = ${serviceName},
            cal_event_type_id = COALESCE(
              ${calEventTypeId},
              appointments.cal_event_type_id
            ),
            booking_notes = COALESCE(${bookingNotes}, appointments.booking_notes),
            status       = CASE
              WHEN status = 'pending' THEN 'pending'
              ELSE 'confirmed'
            END,
            -- Keep prior SMS opt-in across client reschedule (Cal re-shows the
            -- checkbox; leaving it unchecked must not revoke an existing yes).
            sms_opt_in   = CASE
              WHEN sms_opt_in IS TRUE THEN TRUE
              WHEN ${parseSmsOptIn(responses, payload.bookingFieldsResponses) === true} THEN TRUE
              ELSE sms_opt_in
            END
        WHERE cal_event_id = ${oldUid}
        RETURNING id, cal_event_id, status, client_phone, service_name,
                  booking_time, sms_opt_in
      `;
      if (updatedRows.length > 0) {
        console.log('[api/webhook] BOOKING_RESCHEDULED: appointment moved', {
          appointmentId: updatedRows[0].id,
          oldUid,
          newUid: bookingUid,
          bookingTime,
          endTime,
          changeFeeCharged: Boolean(changeFee),
        });
        try {
          await sql`
            INSERT INTO webhook_events (booking_uid)
            VALUES (${bookingUid})
            ON CONFLICT (booking_uid) DO NOTHING
          `;
        } catch (dedupErr) {
          console.warn(
            '[api/webhook] BOOKING_RESCHEDULED: webhook_events insert failed (non-fatal)',
            { error: dedupErr && dedupErr.message }
          );
        }
        if (updatedRows[0].status === 'confirmed') {
          if (sameSlot) {
            console.log(
              '[api/webhook] BOOKING_RESCHEDULED: same_slot_noop — skipping reminder re-queue and reschedule SMS',
              { bookingUid }
            );
          } else {
            const emailSchedule = await rescheduleAppointmentReminderEmails(bookingUid);
            console.log('[api/webhook] BOOKING_RESCHEDULED: reminder emails re-queued', {
              bookingUid,
              emailSchedule,
            });
            try {
              const row = updatedRows[0];
              const bt =
                row.booking_time instanceof Date
                  ? row.booking_time.toISOString()
                  : row.booking_time
                    ? String(row.booking_time)
                    : bookingTime;
              const smsResult = await notifyAppointmentRescheduled({
                bookingUid,
                bookingTime: bt,
                clientPhone: row.client_phone,
                serviceName: row.service_name || serviceName,
                smsOptIn: row.sms_opt_in,
                scheduleSmsReminders: true,
              });
              console.log('[api/webhook] BOOKING_RESCHEDULED: reschedule SMS', {
                bookingUid,
                smsResult,
              });
            } catch (smsErr) {
              console.warn(
                '[api/webhook] BOOKING_RESCHEDULED: SMS failed (non-fatal)',
                { bookingUid, error: smsErr && smsErr.message }
              );
            }
          }
        }
        return res
          .status(200)
          .json({
            ok: true,
            event: 'BOOKING_RESCHEDULED',
            change_fee: changeFee,
            same_slot: sameSlot || undefined,
          });
      }
      console.warn(
        '[api/webhook] BOOKING_RESCHEDULED: no matching appointment for oldUid — skipping (avoid duplicate row)',
        { oldUid, newUid: bookingUid }
      );
      return res
        .status(200)
        .json({ ok: true, skipped: 'reschedule_row_not_found' });
    } catch (err) {
      console.error('[api/webhook] BOOKING_RESCHEDULED: db update failed', {
        oldUid,
        newUid: bookingUid,
        error: err && err.message,
      });
      return res
        .status(200)
        .json({ ok: true, skipped: 'reschedule_update_failed' });
    }
  }

  // ── BOOKING_CANCELLED BRANCH ────────────────────────────────────────────
  // Cal fires this for ANY cancellation. We map to the most specific
  // local status:
  //   • Abandoned-checkout cron → 'canceled_by_system' (cancellationReason).
  //   • Admin dashboard cancel → preserve 'canceled_by_admin' (reason + row).
  //   • Client cancel 2h–24h before start + vaulted card → charge 50% of
  //     service price → 'canceled_by_client_late' on success.
  //   • Client cancel under 2h → charge 100% → status 'no-show' on success.
  //   • Client cancel outside the window / charge skipped → 'canceled_by_client'.
  //
  // Penalty guardrails: never charge for admin/system rows or system
  // abandon reasons. Stripe/DB failures are logged; webhook still 200.
  if (triggerEvent === 'BOOKING_CANCELLED') {
    const cancellationReason = unwrap(payload.cancellationReason);
    const systemAbandon = isSystemAbandonCancellation(cancellationReason);

    let lateCancelCharge = null;

    try {
      const { rows: removedBlockRows } = await sql`
        DELETE FROM studio_time_blocks
        WHERE cal_booking_uid = ${bookingUid}
        RETURNING id
      `;
      if (removedBlockRows.length > 0) {
        console.log('[api/webhook] BOOKING_CANCELLED: studio_time_blocks row removed', {
          bookingUid,
        });
        return res.status(200).json({ ok: true, event: 'BOOKING_CANCELLED', timeBlockRemoved: true });
      }
    } catch (blockErr) {
      console.warn('[api/webhook] BOOKING_CANCELLED: studio_time_blocks cleanup failed', {
        bookingUid,
        error: blockErr && blockErr.message,
      });
    }

    try {
      const { rows: existingRows } = await sql`
        SELECT
          a.id,
          a.cal_event_id,
          a.status,
          a.stripe_customer_id,
          a.stripe_payment_intent_id,
          a.payment_timing,
          a.booking_time,
          a.end_time,
          a.service_name,
          a.client_phone,
          a.sms_opt_in,
          a.client_id::text AS client_id,
          a.quoted_service_price_cents::numeric / 100 AS service_price
        FROM appointments a
        LEFT JOIN LATERAL (
          SELECT s.price
          FROM site_services s
          WHERE s.is_active = TRUE
          AND (
            (
              a.cal_event_type_id IS NOT NULL
              AND s.cal_event_id = a.cal_event_type_id
            )
            OR (
              a.cal_event_type_id IS NULL
              AND s.title = split_part(a.service_name, ' between ', 1)
              AND (
                lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
                  'classic', 'hybrid', 'volume'
                )
                OR (
                  a.booking_time IS NOT NULL
                  AND a.end_time IS NOT NULL
                  AND s.duration_mins IS NOT NULL
                  AND s.duration_mins = GREATEST(
                    1,
                    ROUND(
                      EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                    )
                  )::integer
                )
              )
            )
          )
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
        ) s ON TRUE
        WHERE a.cal_event_id = ${bookingUid}
        LIMIT 1
      `;
      const existing = existingRows[0] || null;

      if (!existing) {
        console.warn(
          '[api/webhook] BOOKING_CANCELLED: no appointment row for uid',
          { bookingUid, cancellationReason }
        );
        return res.status(200).json({ ok: true, event: 'BOOKING_CANCELLED' });
      }

      const existingStatus = (existing.status || '').toLowerCase();

      if (systemAbandon) {
        // Only flip PENDING holds. A confirmed row means the client paid /
        // vaulted a card while the hold-release raced us — flipping it here
        // would silently cancel a paid appointment with no refund.
        const { rows: updatedRows } = await sql`
          UPDATE appointments
          SET status = 'canceled_by_system'
          WHERE cal_event_id = ${bookingUid}
            AND (status IS NULL OR status = 'pending')
          RETURNING cal_event_id, status
        `;
        if (updatedRows.length === 0) {
          if (existingStatus === 'confirmed') {
            console.error(
              '[api/webhook] BOOKING_CANCELLED (system abandon) raced a CONFIRMED booking — Cal cancelled but local row kept. Re-accept or rebook on Cal manually.',
              { bookingUid, cancellationReason }
            );
          } else {
            console.warn(
              '[api/webhook] BOOKING_CANCELLED (system abandon): no pending row to update',
              { bookingUid, cancellationReason, existingStatus }
            );
          }
        } else {
          console.log(
            '[api/webhook] BOOKING_CANCELLED: appointment marked canceled_by_system',
            { bookingUid, cancellationReason }
          );
        }
        return res.status(200).json({ ok: true, event: 'BOOKING_CANCELLED' });
      }

      if (
        shouldSkipLateCancelPenalty({
          existingStatus,
          cancellationReason,
          systemAbandon: false,
        })
      ) {
        if (existingStatus === 'canceled_by_admin') {
          console.log(
            '[api/webhook] BOOKING_CANCELLED: preserved canceled_by_admin (no late fee)',
            { bookingUid, cancellationReason }
          );
        } else if (existingStatus === 'canceled_by_system') {
          console.log(
            '[api/webhook] BOOKING_CANCELLED: preserved canceled_by_system (no late fee)',
            { bookingUid, cancellationReason }
          );
        } else if (existingStatus === 'canceled_by_client_late') {
          console.log(
            '[api/webhook] BOOKING_CANCELLED: already canceled_by_client_late (no duplicate charge)',
            { bookingUid }
          );
        } else if (existingStatus === 'no-show') {
          console.log(
            '[api/webhook] BOOKING_CANCELLED: already no-show (no duplicate charge)',
            { bookingUid }
          );
        } else {
          const { rows: updatedRows } = await sql`
            UPDATE appointments
            SET status = 'canceled_by_admin'
            WHERE cal_event_id = ${bookingUid}
              AND (status IS NULL OR status NOT IN ('canceled_by_admin', 'canceled_by_system', 'no-show'))
            RETURNING cal_event_id, status
          `;
          if (updatedRows.length > 0) {
            console.log(
              '[api/webhook] BOOKING_CANCELLED: appointment marked canceled_by_admin',
              { bookingUid, cancellationReason }
            );
          }
        }
        return res.status(200).json({ ok: true, event: 'BOOKING_CANCELLED' });
      }

      // Client-initiated cancellation — tiered fee (50% / 100%) per policy.
      // When Cal cancels the old booking as part of a reschedule, use the same
      // dedupe key + action as BOOKING_RESCHEDULED so the free pass / charge
      // is applied exactly once even if both webhooks fire.
      let targetStatus = 'canceled_by_client';
      let setNoShowStrike = null;
      const penaltyKindPreview = classifyClientCancelPenalty(existing.booking_time);
      const rescheduleCancel = isRescheduleCancellation(
        payload,
        cancellationReason
      );

      lateCancelCharge = await applyClientChangePenaltyFee({
        existing,
        dedupeKey: rescheduleCancel
          ? `${bookingUid}:change_fee`
          : `${bookingUid}:cancel_fee`,
        action: rescheduleCancel ? 'reschedule' : 'cancel',
        logPrefix: '[api/webhook] BOOKING_CANCELLED',
      });

      if (lateCancelCharge) {
        if (lateCancelCharge.penalty_kind === 'no_show_full') {
          targetStatus = 'no-show';
          setNoShowStrike = false;
        } else if (lateCancelCharge.penalty_kind === 'late_half') {
          targetStatus = 'canceled_by_client_late';
        }
      }

      const { rows: updatedRows } =
        setNoShowStrike === false
          ? await sql`
              UPDATE appointments
              SET status = ${targetStatus}, no_show_strike = FALSE
              WHERE cal_event_id = ${bookingUid}
                AND (status IS NULL OR status NOT IN ('canceled_by_admin', 'canceled_by_system', 'no-show'))
              RETURNING cal_event_id, status
            `
          : await sql`
              UPDATE appointments
              SET status = ${targetStatus}
              WHERE cal_event_id = ${bookingUid}
                AND (status IS NULL OR status NOT IN ('canceled_by_admin', 'canceled_by_system', 'no-show'))
              RETURNING cal_event_id, status
            `;
      if (updatedRows.length === 0) {
        console.warn(
          '[api/webhook] BOOKING_CANCELLED: client status not updated — preserved admin/system/no-show or missing',
          { bookingUid, targetStatus, cancellationReason }
        );
      } else {
        console.log(
          '[api/webhook] BOOKING_CANCELLED: appointment marked',
          {
            bookingUid,
            status: updatedRows[0].status,
            cancellationReason,
            penaltyKind: lateCancelCharge?.penalty_kind || penaltyKindPreview,
            feeCharged: Boolean(lateCancelCharge),
          }
        );

        // Cancel SMS when no fee / free-pass SMS already covered the outcome.
        // Skip reschedule-driven cancels (those get the reschedule SMS).
        if (!rescheduleCancel) {
          const feeOrPassSmsAlreadySent = Boolean(
            lateCancelCharge &&
              (lateCancelCharge.waived || lateCancelCharge.penalty_kind)
          );
          if (!feeOrPassSmsAlreadySent) {
            const bookingTimeIso =
              existing.booking_time instanceof Date
                ? existing.booking_time.toISOString()
                : existing.booking_time
                  ? String(existing.booking_time)
                  : null;
            const serviceLabel =
              (existing.service_name || 'appointment')
                .split(' between ')[0]
                ?.trim() || 'appointment';
            try {
              if (
                penaltyKindPreview === 'none' &&
                isPrepaidPayNowAppointment(existing)
              ) {
                const refundResult = await refundPrepaidBooking({
                  paymentIntentId: existing.stripe_payment_intent_id,
                  keepFraction: 0,
                  appointmentId: existing.id,
                  calBookingUid: bookingUid,
                  reason: 'Full refund — cancel outside policy window',
                  feeType: 'prepaid_full_refund',
                });
                if (!refundResult.ok) {
                  console.warn(
                    '[api/webhook] BOOKING_CANCELLED: prepaid full refund failed (non-fatal)',
                    {
                      bookingUid,
                      error: refundResult.error,
                      message: refundResult.message,
                    }
                  );
                } else {
                  console.log(
                    '[api/webhook] BOOKING_CANCELLED: prepaid full refund',
                    {
                      bookingUid,
                      refundAmountCents: refundResult.refundAmountCents,
                      refundId: refundResult.refundId,
                    }
                  );
                }
              }
              if (penaltyKindPreview === 'none') {
                await notifyClientCancelEarlySms({
                  clientPhone: existing.client_phone,
                  smsOptIn: existing.sms_opt_in,
                  serviceName: serviceLabel,
                  bookingTime: bookingTimeIso,
                  bookingUid,
                });
              } else {
                await notifyClientCancelLateNoFeeSms({
                  clientPhone: existing.client_phone,
                  smsOptIn: existing.sms_opt_in,
                  serviceName: serviceLabel,
                  bookingTime: bookingTimeIso,
                  bookingUid,
                });
              }
            } catch (smsErr) {
              console.warn(
                '[api/webhook] BOOKING_CANCELLED: cancel SMS failed (non-fatal)',
                { bookingUid, error: smsErr && smsErr.message }
              );
            }
          }
        }
      }
    } catch (err) {
      console.error('[api/webhook] BOOKING_CANCELLED: handler failed', {
        bookingUid,
        cancellationReason,
        error: err && err.message,
      });
    }

    return res.status(200).json({
      ok: true,
      event: 'BOOKING_CANCELLED',
      late_cancel_charge: lateCancelCharge,
    });
  }

  // Cal sends many webhook triggers we don't ingest. Only creation-style
  // events (plus the legacy empty triggerEvent) reach the upsert path.
  const isCreationEvent =
    !triggerEvent ||
    APPOINTMENT_CREATION_EVENTS.has(triggerEvent);
  if (!isCreationEvent) {
    console.log('[api/webhook] ignored trigger — no appointment upsert', {
      triggerEvent,
      bookingUid,
    });
    return res.status(200).json({ ok: true, skipped: 'ignored_event' });
  }

  const normPhoneEarly = normaliseClientPhoneForStorage(clientPhone);
  if (!clientEmail && !normPhoneEarly) {
    console.warn('[api/webhook] no email or phone on payload — skipping', {
      bookingUid,
      triggerEvent,
    });
    return res.status(200).json({ ok: true, skipped: 'no_contact' });
  }

  // ── IDEMPOTENCY GATE ─────────────────────────────────────────────────────
  // BOOKING_REQUESTED: skip only if we already have a local row (embed
  // init or a prior REQUESTED delivery). Do NOT use webhook_events here —
  // a later BOOKING_CREATED must still be allowed to run SMS/QStash.
  if (triggerEvent === 'BOOKING_REQUESTED') {
    try {
      const { rows: existing } = await sql`
        SELECT status FROM appointments
        WHERE cal_event_id = ${bookingUid}
        LIMIT 1
      `;
      if (existing.length > 0) {
        console.log(
          '[api/webhook] BOOKING_REQUESTED duplicate — appointment already exists',
          { bookingUid, status: existing[0].status }
        );
        return res.status(200).json({ ok: true, skipped: 'already_exists' });
      }
    } catch (err) {
      console.error('[api/webhook] BOOKING_REQUESTED existence check failed:', {
        bookingUid,
        error: err && err.message,
      });
      return res.status(200).json({ ok: true, skipped: 'db_check_failed' });
    }
  } else {
    // BOOKING_CREATED: do not skip the appointment upsert when
    // webhook_events already has this UID (confirmation SMS marks that
    // row). Older code returned early here, which could leave an admin
    // booking without a confirmed row if complete raced the webhook.
    try {
      const { rows } = await sql`
        SELECT 1 FROM webhook_events WHERE booking_uid = ${bookingUid} LIMIT 1
      `;
      if (rows.length > 0) {
        console.log('[api/webhook] confirmation already recorded — still upserting appointment', {
          bookingUid,
        });
      }
    } catch (err) {
      console.error('[api/webhook] idempotency check failed:', {
        bookingUid,
        error: err && err.message,
      });
    }
  }

  // ── CLIENT UPSERT ────────────────────────────────────────────────────────
  // Phone-first CRM upsert (see lib/client-upsert.js). When Cal omits a
  // phone we fall back to the legacy email-keyed insert so the webhook
  // still succeeds.
  const {
    upsertClientByPhonePrimary,
    upsertClientByEmailFallback,
  } = require('../client-upsert.js');
  const normPhone = normPhoneEarly;
  const appointmentPhone = normPhone || null;
  let clientId;
  try {
    if (normPhone) {
      const upserted = await upsertClientByPhonePrimary({
        firstName,
        lastName,
        email: clientEmail,
        phoneRaw: clientPhone,
      });
      clientId = upserted.clientId;
    } else {
      clientId = await upsertClientByEmailFallback({
        firstName,
        lastName,
        email: clientEmail,
        normPhone,
      });
    }
    if (!clientId) {
      console.error('[api/webhook] client upsert returned no id', {
        bookingUid,
        email: maskEmail(clientEmail)
      });
      return res.status(200).json({ ok: true, skipped: 'client_upsert_no_id' });
    }
  } catch (err) {
    console.error('[api/webhook] client upsert failed:', {
      bookingUid,
      email: maskEmail(clientEmail),
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'client_upsert_failed' });
  }

  // ── APPOINTMENT UPSERT ──────────────────────────────────────────────────
  // Insert the appointment keyed by cal_event_id (payload.uid). Denormalised
  // client_* fields (incl. phone) are stored alongside the client_id FK so
  // downstream scheduled jobs (api/remind, api/feedback) can look up everything
  // they need from a single row without a JOIN, and so the appointment remains
  // self-contained if the client row is ever deleted/anonymised.
  //
  // Status discipline (state machine):
  //   • First-time INSERT lands as 'pending' — hold until /checkout vaults
  //     a card. SMS + reminder emails are deferred to /api/booking/confirm
  //     (not here) so abandoned holds never text the client.
  //   • ON CONFLICT DO UPDATE DELIBERATELY does NOT touch `status`.
  // Website SMS opt-in is stored here from the Cal sms-consent checkbox so
  // confirm can gate Twilio without re-parsing the Cal payload.
  const smsOptIn =
    parseSmsOptIn(responses, payload.bookingFieldsResponses) === true ||
    isManualAdmin === true;
  const initialStatus = isManualAdmin ? 'confirmed' : 'pending';
  try {
    await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, end_time, cal_event_id,
        cal_event_type_id,
        client_first_name, client_last_name, client_email, client_phone,
        booking_notes, status, sms_opt_in
      )
      VALUES (
        ${clientId}, ${serviceName}, ${bookingTime}, ${endTime}, ${bookingUid},
        ${calEventTypeId},
        ${firstName}, ${lastName}, ${clientEmail}, ${appointmentPhone},
        ${bookingNotes}, ${initialStatus}, ${smsOptIn}
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        cal_event_type_id = COALESCE(
          EXCLUDED.cal_event_type_id,
          appointments.cal_event_type_id
        ),
        quoted_service_price_cents = COALESCE(
          appointments.quoted_service_price_cents,
          EXCLUDED.quoted_service_price_cents
        ),
        booking_time = EXCLUDED.booking_time,
        end_time = EXCLUDED.end_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = COALESCE(
          EXCLUDED.client_email,
          CASE
            WHEN appointments.client_email IS NULL THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE '%@sms.cal.com' THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE 'bookings+%' THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE '%@placeholder.sadiemarie.co' THEN NULL
            ELSE appointments.client_email
          END
        ),
        client_phone = EXCLUDED.client_phone,
        booking_notes = COALESCE(EXCLUDED.booking_notes, appointments.booking_notes),
        -- Sticky SMS opt-in: once true for this appointment, never clear it
        -- on a later Cal webhook (e.g. reschedule form with unchecked consent).
        sms_opt_in = (appointments.sms_opt_in IS TRUE) OR (EXCLUDED.sms_opt_in IS TRUE),
        status = CASE
          WHEN ${isManualAdmin} AND LOWER(COALESCE(appointments.status, '')) = 'pending'
            THEN 'confirmed'
          ELSE appointments.status
        END
    `;
  } catch (err) {
    console.error('[api/webhook] appointment upsert failed:', {
      bookingUid,
      clientId,
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'appointment_upsert_failed' });
  }

  const treatAsManualAdmin = Boolean(isManualAdmin);

  // Public checkout holds must auto-release even when /api/booking/init
  // fails (e.g. missing email + SMS opt-out). Admin manual bookings are
  // confirmed immediately — do not schedule a hold release.
  if (!treatAsManualAdmin && bookingUid) {
    try {
      const releaseJob = await scheduleAbandonedHoldRelease(bookingUid);
      if (!releaseJob.scheduled) {
        console.warn('[api/webhook] abandoned-hold release not scheduled', {
          bookingUid,
          reason: releaseJob.reason,
        });
      }
    } catch (err) {
      console.warn('[api/webhook] abandoned-hold schedule threw', {
        bookingUid,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  if (triggerEvent === 'BOOKING_REQUESTED') {
    console.log('[api/webhook] BOOKING_REQUESTED: pending appointment stored', {
      bookingUid,
    });
    return res.status(200).json({
      ok: true,
      event: 'BOOKING_REQUESTED',
      status: treatAsManualAdmin ? 'confirmed' : 'pending',
      dbWritten: true,
    });
  }

  if (treatAsManualAdmin) {
    let notifications = null;
    try {
      notifications = await notifyBookingConfirmed({
        bookingUid,
        bookingTime,
        endTime,
        clientPhone: appointmentPhone,
        clientName,
        serviceName,
        clientId,
        clientEmail,
        skipIfAlreadySent: true,
        smsOptIn: true,
      });
    } catch (err) {
      console.error(
        '[api/webhook] manual admin notifyBookingConfirmed failed (non-blocking)',
        {
          bookingUid,
          error: err && err.message ? err.message : String(err),
        }
      );
      notifications = {
        ok: false,
        error: err && err.message ? err.message : String(err),
      };
    }
    console.log('[api/webhook] manual admin booking confirmed + reminders queued', {
      bookingUid,
      skipped: notifications && notifications.skipped,
    });
    return res.status(200).json({
      ok: true,
      dbWritten: true,
      status: 'confirmed',
      notifications,
    });
  }

  // Public website bookings: confirmation SMS + QStash reminders run from
  // /api/booking/confirm after the card is vaulted (A2P + hold semantics).
  console.log(
    '[api/webhook] BOOKING_CREATED stored — notifications deferred to checkout confirm',
    { bookingUid, smsOptIn }
  );
  return res.status(200).json({
    ok: true,
    dbWritten: true,
    smsOptIn,
    skipped: 'notifications_deferred_to_checkout_confirm',
  });
};
