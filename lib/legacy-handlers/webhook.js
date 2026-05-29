/**
 * POST /api/webhook
 *
 * Receives Cal.com webhook events and dispatches on `triggerEvent`:
 *   - BOOKING_REQUESTED  → client + appointment upsert as 'pending' (fires
 *                          when the guest confirms a slot on event types
 *                          that "Require confirmation" — this is the
 *                          handoff moment before /checkout).
 *   - BOOKING_CREATED    → same upsert path; may fire for auto-confirmed
 *                          types or after upstream acceptance. SMS +
 *                          QStash run only on BOOKING_CREATED so we don't
 *                          text "confirmed" before card vaulting.
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
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER   (the Twilio number the SMS is sent from)
 *   - POSTGRES_URL          (read by @vercel/postgres automatically)
 *   - QSTASH_TOKEN          (Upstash QStash publish credential)
 *   - PUBLIC_BASE_URL       (optional override; defaults to the prod domain)
 */

const { sql } = require('@vercel/postgres');
const {
  chargeLateCancelFee,
  isLateCancellationWindow,
  shouldSkipLateCancelPenalty,
} = require('../late-cancel-charge');

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

  return { serviceName, bookingTime, endTime };
};

// Must stay in sync with `CAL_CANCEL_REASON` in
// `app/api/cron/cleanup-abandoned/route.ts`. Cal echoes this string on
// the BOOKING_CANCELLED webhook after our abandoned-checkout sweep.
const SYSTEM_ABANDON_CANCEL_REASON = 'Checkout abandoned after 8 minutes.';

const isSystemAbandonCancellation = (reason) => {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed === SYSTEM_ABANDON_CANCEL_REASON;
};

// Event types that should create / refresh a local appointments row.
const APPOINTMENT_CREATION_EVENTS = new Set([
  'BOOKING_REQUESTED',
  'BOOKING_CREATED',
]);

const { notifyBookingConfirmed } = require('../booking-notifications.js');
const { normaliseClientPhoneForStorage } = require('../client-phone.js');
const { normalizeClientEmailForStorage } = require('../client-email.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
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
  } = resolveShadowAppointmentFields(payload);

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

  // ── BOOKING_RESCHEDULED BRANCH ──────────────────────────────────────────
  // Cal fires this whenever a booking is moved to a new slot — both for
  // admin-initiated reschedules (which the dashboard also handles
  // synchronously via /api/admin/appointments/<id>/reschedule for instant
  // UI feedback) and for client-initiated ones (the "Reschedule" link in
  // Cal's confirmation email). Without this branch, BOOKING_RESCHEDULED
  // would fall through to the creation flow below and INSERT a duplicate
  // appointment row at the new time while leaving the old one stranded.
  //
  // Strategy: locate the existing row by its OLD UID (Cal sends it as
  // payload.rescheduleUid; we also accept `fromReschedule.uid` defensively
  // because Cal has shipped both shapes historically), then UPDATE its
  // cal_event_id, booking_time, end_time, and status. The row's primary
  // key, client_id, contact fields, and service_name are preserved so
  // CRM linkage and history stay intact.
  //
  // If no row matches the OLD UID — e.g. the original booking was created
  // before this table existed, or somebody deleted it manually — we fall
  // through into the regular creation flow so the new slot still ends up
  // tracked locally, just as a fresh row. Better than silently dropping it.
  //
  // Idempotency: re-running the same UPDATE is harmless. The synchronous
  // admin endpoint may already have applied the change before this
  // webhook lands; the SET clauses just rewrite to the same values.
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

    // NOTE on status: a reschedule must NEVER promote a row's lifecycle
    // state. If the client rescheduled a still-pending hold (i.e. they
    // never finished the card-vault step at /checkout), the row must
    // stay 'pending' so the cron sweep can release it. We only force
    // back to 'confirmed' when the row was already in an active state
    // (confirmed) or a cancelled-by-* terminal — in which case the
    // reschedule effectively un-cancels and the slot is live again.
    try {
      const { rows: updatedRows } = await sql`
        UPDATE appointments
        SET cal_event_id = ${bookingUid},
            booking_time = ${bookingTime},
            end_time     = ${endTime},
            service_name = ${serviceName},
            status       = CASE
              WHEN status = 'pending' THEN 'pending'
              ELSE 'confirmed'
            END
        WHERE cal_event_id = ${oldUid}
        RETURNING id, cal_event_id
      `;
      if (updatedRows.length > 0) {
        console.log('[api/webhook] BOOKING_RESCHEDULED: appointment moved', {
          appointmentId: updatedRows[0].id,
          oldUid,
          newUid: bookingUid,
          bookingTime,
          endTime,
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
        return res
          .status(200)
          .json({ ok: true, event: 'BOOKING_RESCHEDULED' });
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
  //   • Client cancel within 24h of start + vaulted card → charge $20,
  //     then 'canceled_by_client_late' on success, else 'canceled_by_client'.
  //   • Client cancel outside the window → 'canceled_by_client'.
  //
  // Penalty guardrails: never charge for admin/system rows or system
  // abandon reasons. Stripe/DB failures are logged; webhook still 200.
  if (triggerEvent === 'BOOKING_CANCELLED') {
    const cancellationReason = unwrap(payload.cancellationReason);
    const systemAbandon = isSystemAbandonCancellation(cancellationReason);

    let lateCancelCharge = null;

    try {
      const { rows: existingRows } = await sql`
        SELECT
          id,
          status,
          stripe_customer_id,
          booking_time,
          service_name
        FROM appointments
        WHERE cal_event_id = ${bookingUid}
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
        const { rows: updatedRows } = await sql`
          UPDATE appointments
          SET status = 'canceled_by_system'
          WHERE cal_event_id = ${bookingUid}
            AND (status IS NULL OR status <> 'canceled_by_admin')
          RETURNING cal_event_id, status
        `;
        if (updatedRows.length === 0) {
          console.warn(
            '[api/webhook] BOOKING_CANCELLED (system abandon): no row updated — preserved canceled_by_admin',
            { bookingUid, cancellationReason }
          );
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
        } else {
          const { rows: updatedRows } = await sql`
            UPDATE appointments
            SET status = 'canceled_by_admin'
            WHERE cal_event_id = ${bookingUid}
              AND (status IS NULL OR status NOT IN ('canceled_by_admin', 'canceled_by_system'))
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

      // Client-initiated cancellation — optional $20 late fee.
      let targetStatus = 'canceled_by_client';
      const serviceLabel =
        (existing.service_name || 'appointment')
          .split(' between ')[0]
          ?.trim() || 'appointment';
      const withinLateWindow = isLateCancellationWindow(existing.booking_time);
      const hasVault =
        typeof existing.stripe_customer_id === 'string' &&
        existing.stripe_customer_id.length > 0;
      const chargeEligible =
        withinLateWindow &&
        hasVault &&
        (existingStatus === 'confirmed' ||
          existingStatus === 'canceled_by_client');

      if (chargeEligible) {
        try {
          const chargeResult = await chargeLateCancelFee({
            stripeCustomerId: existing.stripe_customer_id,
            appointmentId: existing.id,
            calBookingUid: bookingUid,
            serviceLabel,
          });
          if (chargeResult.ok) {
            targetStatus = 'canceled_by_client_late';
            lateCancelCharge = {
              payment_intent_id: chargeResult.paymentIntentId,
              amount_cents: chargeResult.amountCents,
              currency: chargeResult.currency,
            };
            console.log(
              '[api/webhook] BOOKING_CANCELLED: late cancel fee charged',
              {
                bookingUid,
                paymentIntentId: chargeResult.paymentIntentId,
                amountCents: chargeResult.amountCents,
              }
            );
          } else {
            console.warn(
              '[api/webhook] BOOKING_CANCELLED: late cancel fee skipped',
              {
                bookingUid,
                error: chargeResult.error,
                message: chargeResult.message,
              }
            );
          }
        } catch (chargeErr) {
          console.error(
            '[api/webhook] BOOKING_CANCELLED: late cancel charge threw',
            {
              bookingUid,
              error: chargeErr && chargeErr.message,
            }
          );
        }
      } else if (withinLateWindow && !hasVault) {
        console.warn(
          '[api/webhook] BOOKING_CANCELLED: late window but no stripe_customer_id — no fee',
          { bookingUid, existingStatus }
        );
      }

      const { rows: updatedRows } = await sql`
        UPDATE appointments
        SET status = ${targetStatus}
        WHERE cal_event_id = ${bookingUid}
          AND (status IS NULL OR status NOT IN ('canceled_by_admin', 'canceled_by_system'))
        RETURNING cal_event_id, status
      `;
      if (updatedRows.length === 0) {
        console.warn(
          '[api/webhook] BOOKING_CANCELLED: client status not updated — preserved admin/system or missing',
          { bookingUid, targetStatus, cancellationReason }
        );
      } else {
        console.log(
          '[api/webhook] BOOKING_CANCELLED: appointment marked',
          {
            bookingUid,
            status: updatedRows[0].status,
            cancellationReason,
            lateFeeCharged: targetStatus === 'canceled_by_client_late',
          }
        );
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
    // BOOKING_CREATED (and legacy empty triggerEvent): webhook_events
    // dedupes SMS/QStash replays. Appointment upsert still runs on
    // conflict — this gate is only about not texting twice.
    try {
      const { rows } = await sql`
        SELECT 1 FROM webhook_events WHERE booking_uid = ${bookingUid} LIMIT 1
      `;
      if (rows.length > 0) {
        console.log('[api/webhook] duplicate webhook — already processed', {
          bookingUid,
        });
        return res.status(200).json({ ok: true, skipped: 'duplicate' });
      }
    } catch (err) {
      console.error('[api/webhook] idempotency check failed:', {
        bookingUid,
        error: err && err.message,
      });
      return res.status(200).json({ ok: true, skipped: 'db_check_failed' });
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
  //   • First-time INSERT lands as 'pending' — Cal.com is configured to
  //     require confirmation, so every fresh booking is an unconfirmed
  //     hold until the client completes the card-vault handoff at
  //     /checkout. The dashboard's Month/Week/3-Day views hide pending
  //     rows so an abandoned cart never squats on a slot visually.
  //     /api/booking/confirm flips the row to 'confirmed' on a successful
  //     Stripe SetupIntent.
  //   • ON CONFLICT DO UPDATE DELIBERATELY does NOT touch `status`. A
  //     duplicate webhook delivery (Cal retries, operator-triggered
  //     replays from the dashboard, BOOKING_RESCHEDULED race with the
  //     branch above) must not downgrade an already-confirmed row back
  //     to pending. The webhook_events idempotency table catches most
  //     replays before we get here, but this is belt-and-braces.
  try {
    await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, end_time, cal_event_id,
        client_first_name, client_last_name, client_email, client_phone,
        status
      )
      VALUES (
        ${clientId}, ${serviceName}, ${bookingTime}, ${endTime}, ${bookingUid},
        ${firstName}, ${lastName}, ${clientEmail}, ${appointmentPhone},
        'pending'
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        booking_time = EXCLUDED.booking_time,
        end_time = EXCLUDED.end_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = COALESCE(EXCLUDED.client_email, appointments.client_email),
        client_phone = EXCLUDED.client_phone
    `;
  } catch (err) {
    console.error('[api/webhook] appointment upsert failed:', {
      bookingUid,
      clientId,
      error: err && err.message
    });
    return res.status(200).json({ ok: true, skipped: 'appointment_upsert_failed' });
  }

  if (triggerEvent === 'BOOKING_REQUESTED') {
    console.log('[api/webhook] BOOKING_REQUESTED: pending appointment stored', {
      bookingUid,
    });
    return res.status(200).json({
      ok: true,
      event: 'BOOKING_REQUESTED',
      status: 'pending',
      dbWritten: true,
    });
  }

  const smsPhone = appointmentPhone || clientPhone;
  const notifyResult = await notifyBookingConfirmed({
    bookingUid,
    bookingTime,
    clientPhone: smsPhone,
    clientName,
    serviceName,
    skipIfAlreadySent: false,
  });

  return res.status(200).json({
    ok: true,
    dbWritten: true,
    notifications: notifyResult,
  });
};
