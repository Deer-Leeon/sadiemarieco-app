/**
 * POST /api/booking/confirm
 *
 * The "close-the-loop" endpoint that runs after the /checkout page
 * has collected a card via `stripe.confirmSetup()`. Wires three
 * external systems together in a deliberate order:
 *
 *   1. Stripe — verify the SetupIntent actually succeeded, attach the
 *      vaulted PaymentMethod to the Customer created during
 *      `/api/stripe/create-setup-intent`, and set it as the default
 *      for future off-session charges (no-show / late-cancel fees).
 *   2. Postgres — write the new Customer id onto the appointments
 *      row, linking the booking to its vaulted card. Lookup is by
 *      Cal booking UID (stored on `appointments.cal_event_id`).
 *   3. Cal.com — accept the pending booking upstream so Cal's
 *      dashboard + attendee emails show "Confirmed" (not
 *      "Unconfirmed"). Runs AFTER Postgres so a Cal hiccup never
 *      blocks the card vault. Local DB is source of truth.
 *   4. Notifications — confirmation SMS + QStash 24h/1h reminders
 *      (and reminder emails) via `notifyBookingConfirmed`, gated on
 *      `appointments.sms_opt_in` from the Cal sms-consent checkbox.
 *
 * Cal.com sync (tried in order):
 *   1. PATCH v1 `/bookings/<uid>?apiKey=…` with `{ status: 'ACCEPTED' }`
 *      — same pattern as `/api/qstash/release-hold` Cal cancel.
 *   2. If v1 fails, POST v2 `/bookings/<uid>/confirm` with Bearer
 *      auth — same family as `api/cancel-booking.js`.
 *
 * Idempotency: the route is safe to retry on the same setupIntentId
 * if Cal or Postgres fail mid-flow. Stripe `customers.create` will
 * create a duplicate Customer on retry (Stripe deliberately does
 * not dedupe), but PaymentMethod attach is idempotent and the DB
 * update is a plain UPDATE … WHERE cal_event_id, so re-running
 * with a different customer id just overwrites. We don't pass
 * an idempotency key on customers.create because the cost of a
 * duplicate Customer row in Stripe is low (no PII duplication
 * beyond what the client already gave us) and adding key state to
 * the request would require persisting it ourselves anyway.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
  trackBookingEvent,
} from '@/lib/booking-analytics';
import {
  getAppointmentStripeByCalUid,
  STRIPE_CUSTOMER_ID_RE,
} from '@/lib/appointment-stripe';
import {
  insertOnlinePrepaidSettlement,
  isSettlementUniqueConflict,
} from '@/lib/appointment-settlement';
import { HOLD_EXPIRED_MESSAGE, isHoldExpired } from '@/lib/booking-hold';
import { notifyBookingConfirmed } from '@/lib/booking-notifications';
import { stripeCardCheckRejection } from '@/lib/stripe-card-checks';
import { acceptOnCal } from '@/lib/cal-accept';
import { CAL_BOOKINGS_API_VERSION } from '@/lib/cal-proxy';
import { isValidEmail } from '@/lib/client-identity';
import { hasRealBookingEmail } from '@/lib/booking-contact-channel';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';
import { stripe } from '@/lib/stripe';
import {
  getStripeEnvModes,
  shouldEnforceStripeMode,
  stripeModeMismatchMessage,
} from '@/lib/stripe-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CAL_V2_BASE = 'https://api.cal.com/v2';
interface ConfirmBody {
  setupIntentId?: unknown;
  paymentIntentId?: unknown;
  email?: unknown;
  name?: unknown;
  calBookingUid?: unknown;
}

interface ParsedBody {
  setupIntentId: string | null;
  paymentIntentId: string | null;
  paymentTiming: 'pay_later' | 'pay_now';
  /**
   * Email if the client supplied one (URL param or PaymentElement
   * billing details surfaced by the browser); empty string otherwise.
   * The server falls back to the PaymentMethod's `billing_details.email`
   * after retrieving the SetupIntent, so the route handles the
   * "Cal didn't tell us the email" case without making it a hard error.
   */
  email: string;
  /** Same semantics as `email` — best-effort, server-derived if absent. */
  name: string;
  calBookingUid: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBody(input: unknown): ParsedBody | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body' };
  }
  const body = input as ConfirmBody;
  const setupIntentId =
    typeof body.setupIntentId === 'string' ? body.setupIntentId.trim() : '';
  const paymentIntentId =
    typeof body.paymentIntentId === 'string'
      ? body.paymentIntentId.trim()
      : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';

  const hasSetup = setupIntentId.startsWith('seti_');
  const hasPayment = paymentIntentId.startsWith('pi_');
  if (hasSetup === hasPayment) {
    return { error: 'invalid_intent_id' };
  }
  if (!calBookingUid || calBookingUid.length > 200) {
    return { error: 'invalid_cal_booking_uid' };
  }

  const email = isValidEmail(rawEmail) ? rawEmail.trim().toLowerCase() : '';
  const name = rawName.length > 0 && rawName.length <= 200 ? rawName : '';

  return {
    setupIntentId: hasSetup ? setupIntentId : null,
    paymentIntentId: hasPayment ? paymentIntentId : null,
    paymentTiming: hasPayment ? 'pay_now' : 'pay_later',
    email,
    name,
    calBookingUid,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `booking:confirm:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookingConfirm,
  });
  if (limited) return limited;

  if (!stripe) {
    return NextResponse.json(
      {
        error: 'stripe_not_configured',
        message:
          'STRIPE_SECRET_KEY is not set on the server. Card vaulting is unavailable.',
      },
      { status: 503 }
    );
  }

  const stripeModes = getStripeEnvModes();
  if (shouldEnforceStripeMode() && !stripeModes.matchesExpected) {
    const message = stripeModeMismatchMessage(stripeModes);
    console.error('[api/booking/confirm] stripe mode mismatch', {
      secret: stripeModes.secret,
      publishable: stripeModes.publishable,
      expected: stripeModes.expected,
    });
    return NextResponse.json(
      { error: 'stripe_mode_mismatch', message },
      { status: 503 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { setupIntentId, paymentIntentId, paymentTiming, email, name, calBookingUid } =
    parsed;

  // ── 0. HOLD GATE — require a local pending hold; never confirm without one ─
  // Init is fire-and-forget before /checkout navigation. If that failed (or
  // the uid is forged), there is no row and we must not vault + accept on Cal.
  let hold: Awaited<ReturnType<typeof getAppointmentHoldByCalUid>>;
  try {
    hold = await getAppointmentHoldByCalUid(calBookingUid);
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] hold lookup failed:', msg);
    return NextResponse.json(
      { error: 'hold_lookup_failed', message: msg },
      { status: 500 }
    );
  }

  if (!hold) {
    return NextResponse.json(
      {
        error: 'appointment_not_found',
        message:
          'This booking hold was not found. Please pick a time on the calendar again.',
      },
      { status: 404 }
    );
  }

  // Linked Stripe ids for this booking (SetupIntent id written at mint time).
  // Fetched before the status gate so the 'confirmed' branch can tell an
  // idempotent retry (same intent id) apart from a duplicate payment.
  let existingStripe: Awaited<
    ReturnType<typeof getAppointmentStripeByCalUid>
  >;
  try {
    existingStripe = await getAppointmentStripeByCalUid(calBookingUid);
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] stripe row lookup failed:', msg);
    return NextResponse.json(
      { error: 'hold_lookup_failed', message: msg },
      { status: 500 }
    );
  }

  {
    const status = (hold.status || '').toLowerCase();
    if (status === 'confirmed') {
      // Retry of a confirm that already succeeded (page refresh, 3DS
      // return, network retry): same intent id → report success again.
      const matchesLinkedIntent = paymentIntentId
        ? (existingStripe?.stripe_payment_intent_id ?? '').trim() ===
          paymentIntentId
        : (existingStripe?.stripe_setup_intent_id ?? '').trim() ===
          setupIntentId;
      if (matchesLinkedIntent) {
        return NextResponse.json({
          ok: true,
          alreadyConfirmed: true,
          stripeCustomerId: existingStripe?.stripe_customer_id ?? null,
          dbLinked: true,
          cal_accept_error: null,
          notifications: null,
          contact: { sms: false, email: hasRealBookingEmail(email) },
        });
      }

      // A DIFFERENT intent against an already-confirmed booking. If it is a
      // succeeded PaymentIntent for this uid the client was double-charged —
      // refund it immediately.
      if (paymentIntentId && stripe) {
        try {
          const dupPi = await stripe.paymentIntents.retrieve(paymentIntentId);
          const dupUid = (dupPi.metadata?.cal_booking_uid ?? '').trim();
          if (dupPi.status === 'succeeded' && dupUid === calBookingUid) {
            await stripe.refunds.create({ payment_intent: paymentIntentId });
            console.error(
              '[api/booking/confirm] duplicate payment refunded on confirmed booking',
              { calBookingUid, paymentIntentId }
            );
            return NextResponse.json(
              {
                error: 'duplicate_payment_refunded',
                message:
                  'This booking was already confirmed and paid. The extra charge has been refunded to your card.',
              },
              { status: 409 }
            );
          }
        } catch (dupErr) {
          console.error(
            '[api/booking/confirm] duplicate-payment refund attempt failed',
            { calBookingUid, paymentIntentId, error: errorMessage(dupErr) }
          );
        }
      }
      return NextResponse.json(
        {
          error: 'already_confirmed',
          message:
            'This booking is already confirmed. You have not been charged again.',
        },
        { status: 409 }
      );
    }
    if (status === 'canceled_by_system' || isHoldExpired(hold.created_at)) {
      return NextResponse.json(
        {
          error: 'cart_hold_expired',
          message: HOLD_EXPIRED_MESSAGE,
        },
        { status: 400 }
      );
    }
    if (
      status.startsWith('canceled') ||
      status === 'cancelled' ||
      status === 'no-show'
    ) {
      return NextResponse.json(
        {
          error: 'booking_not_confirmable',
          message:
            'This booking can no longer be confirmed. Please pick a new time on the calendar.',
        },
        { status: 409 }
      );
    }
  }

  // ── 1. STRIPE: verify SetupIntent or PaymentIntent succeeded ─────
  let paymentMethodId: string;
  let pmBilling: {
    name: string | null;
    email: string | null;
  } = { name: null, email: null };
  let intentCustomer: string | null = null;
  let payNowAmountCents: number | null = null;

  try {
    if (paymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        paymentIntentId,
        { expand: ['payment_method', 'customer'] }
      );
      if (paymentIntent.status !== 'succeeded') {
        return NextResponse.json(
          {
            error: 'payment_intent_not_succeeded',
            status: paymentIntent.status,
          },
          { status: 400 }
        );
      }
      const metaUid = (paymentIntent.metadata?.cal_booking_uid ?? '').trim();
      if (!metaUid || metaUid !== calBookingUid) {
        return NextResponse.json(
          {
            error: 'payment_intent_booking_mismatch',
            message:
              'This payment does not match the booking. Please try again.',
          },
          { status: 400 }
        );
      }
      const linkedPi = (existingStripe?.stripe_payment_intent_id ?? '').trim();
      if (linkedPi && linkedPi !== paymentIntentId) {
        return NextResponse.json(
          {
            error: 'payment_intent_stale',
            message: 'This payment session is out of date. Please try again.',
          },
          { status: 400 }
        );
      }
      // Server-side amount check: the PI was minted from
      // quoted_service_price_cents; any drift means a stale/incorrect
      // payment session. Refund rather than record a wrong amount.
      const quotedCents = Number(
        existingStripe?.quoted_service_price_cents ?? 0
      );
      if (
        Number.isFinite(quotedCents) &&
        quotedCents >= 50 &&
        paymentIntent.amount !== quotedCents
      ) {
        console.error('[api/booking/confirm] pay-now amount mismatch', {
          calBookingUid,
          paymentIntentId,
          paymentAmount: paymentIntent.amount,
          quotedCents,
        });
        try {
          await stripe.refunds.create({ payment_intent: paymentIntentId });
        } catch (refundErr) {
          console.error(
            '[api/booking/confirm] amount-mismatch refund failed',
            { paymentIntentId, error: errorMessage(refundErr) }
          );
        }
        return NextResponse.json(
          {
            error: 'payment_amount_mismatch',
            message:
              'The payment amount did not match the quoted service price, so it has been refunded. Please book again.',
          },
          { status: 409 }
        );
      }
      payNowAmountCents = paymentIntent.amount;
      intentCustomer =
        typeof paymentIntent.customer === 'string'
          ? paymentIntent.customer
          : paymentIntent.customer &&
              typeof paymentIntent.customer === 'object' &&
              'id' in paymentIntent.customer &&
              typeof paymentIntent.customer.id === 'string'
            ? paymentIntent.customer.id
            : null;
      const pm = paymentIntent.payment_method;
      if (typeof pm === 'string') {
        paymentMethodId = pm;
      } else if (pm && typeof pm === 'object') {
        paymentMethodId = pm.id;
        pmBilling = {
          name: pm.billing_details?.name ?? null,
          email: pm.billing_details?.email ?? null,
        };
      } else {
        paymentMethodId = '';
      }
    } else if (setupIntentId) {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
        expand: ['payment_method', 'customer'],
      });
      if (setupIntent.status !== 'succeeded') {
        return NextResponse.json(
          {
            error: 'setup_intent_not_succeeded',
            status: setupIntent.status,
          },
          { status: 400 }
        );
      }

      const metaUid = (setupIntent.metadata?.cal_booking_uid ?? '').trim();
      if (!metaUid || metaUid !== calBookingUid) {
        console.warn('[api/booking/confirm] setup intent booking mismatch', {
          calBookingUid,
          metaUid: metaUid || null,
          setupIntentId,
        });
        return NextResponse.json(
          {
            error: 'setup_intent_booking_mismatch',
            message:
              'This card session does not match the booking. Please try checkout again.',
          },
          { status: 400 }
        );
      }

      const linkedSetupIntentId = (
        existingStripe?.stripe_setup_intent_id ?? ''
      ).trim();
      if (linkedSetupIntentId && linkedSetupIntentId !== setupIntentId) {
        console.warn(
          '[api/booking/confirm] setup intent not current for booking',
          {
            calBookingUid,
            setupIntentId,
            linkedSetupIntentId,
          }
        );
        return NextResponse.json(
          {
            error: 'setup_intent_stale',
            message:
              'This card session is out of date. Please try checkout again.',
          },
          { status: 400 }
        );
      }

      intentCustomer =
        typeof setupIntent.customer === 'string'
          ? setupIntent.customer
          : setupIntent.customer &&
              typeof setupIntent.customer === 'object' &&
              'id' in setupIntent.customer &&
              typeof setupIntent.customer.id === 'string'
            ? setupIntent.customer.id
            : null;

      const pm = setupIntent.payment_method;
      if (typeof pm === 'string') {
        paymentMethodId = pm;
      } else if (pm && typeof pm === 'object') {
        paymentMethodId = pm.id;
        pmBilling = {
          name: pm.billing_details?.name ?? null,
          email: pm.billing_details?.email ?? null,
        };
      } else {
        paymentMethodId = '';
      }
    } else {
      return NextResponse.json(
        { error: 'invalid_intent_id' },
        { status: 400 }
      );
    }

    if (!paymentMethodId) {
      return NextResponse.json(
        { error: 'no_payment_method_on_intent' },
        { status: 400 }
      );
    }

    const pmFull = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pmBilling.name && pmFull.billing_details?.name) {
      pmBilling.name = pmFull.billing_details.name;
    }
    if (!pmBilling.email && pmFull.billing_details?.email) {
      pmBilling.email = pmFull.billing_details.email;
    }
    const checkReject = stripeCardCheckRejection(
      pmFull.card?.checks ?? null
    );
    if (checkReject) {
      try {
        if (pmFull.customer) {
          await stripe.paymentMethods.detach(paymentMethodId);
        }
      } catch (detachErr) {
        console.warn(
          '[api/booking/confirm] detach after card-check fail:',
          errorMessage(detachErr)
        );
      }
      return NextResponse.json(
        {
          error: 'card_verification_failed',
          message: checkReject,
        },
        { status: 400 }
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] stripe intent retrieve failed:', msg);
    return NextResponse.json(
      { error: 'stripe_retrieve_failed', message: msg },
      { status: 502 }
    );
  }

  // Resolve the final Customer fields. Precedence:
  //   1. URL/body-supplied values (the visitor's Cal booking form input)
  //   2. PaymentElement billing_details (what they typed under the card)
  //   3. Empty — Stripe accepts a Customer with null name/email; the
  //      admin can backfill from the appointments row's
  //      client_email/client_phone (denormalised by the Cal webhook)
  //      if reconciliation is ever needed.
  const resolvedEmail =
    email ||
    (pmBilling.email && isValidEmail(pmBilling.email.trim())
      ? pmBilling.email.trim().toLowerCase()
      : '');
  const resolvedName =
    name ||
    (pmBilling.name && pmBilling.name.trim().length > 0
      ? pmBilling.name.trim().slice(0, 200)
      : '');

  // ── 2. STRIPE: attach PaymentMethod to vault Customer ─────────────
  let stripeCustomerId =
    (intentCustomer && STRIPE_CUSTOMER_ID_RE.test(intentCustomer)
      ? intentCustomer
      : null) ||
    (existingStripe?.stripe_customer_id &&
    STRIPE_CUSTOMER_ID_RE.test(existingStripe.stripe_customer_id)
      ? existingStripe.stripe_customer_id
      : null);

  try {
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: resolvedEmail || undefined,
        name: resolvedName || undefined,
        metadata: { cal_booking_uid: calBookingUid },
      });
      stripeCustomerId = customer.id;
    } else if (resolvedEmail || resolvedName) {
      await stripe.customers.update(stripeCustomerId, {
        email: resolvedEmail || undefined,
        name: resolvedName || undefined,
      });
    }

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== stripeCustomerId) {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: stripeCustomerId,
      });
    }

    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] stripe customer/attach failed:', msg);
    return NextResponse.json(
      { error: 'stripe_customer_attach_failed', message: msg },
      { status: 502 }
    );
  }

  if (!stripeCustomerId || !STRIPE_CUSTOMER_ID_RE.test(stripeCustomerId)) {
    return NextResponse.json(
      { error: 'invalid_stripe_customer_id' },
      { status: 502 }
    );
  }

  // ── 3. POSTGRES: link the vaulted card AND flip status ─────────────
  // `appointments.cal_event_id` actually holds the Cal BOOKING UID
  // (the column predates the field's purpose — see types.ts notes).
  //
  // This is the second half of the booking state machine: the webhook
  // inserted the row as 'pending' when Cal first told us about the
  // booking, and now that the client has vaulted a card we promote
  // the row to 'confirmed' so it appears on the admin's Month/Week/
  // 3-Day calendar views. Status + customer-id update in the same
  // statement so the calendar reflects the booking and the card
  // linkage atomically.
  //
  // WHERE-clause guard: promote ONLY rows still 'pending' (or legacy NULL),
  // atomically. This closes the confirm-vs-release race: if the QStash hold
  // release (or an admin cancel) flipped the row between our gate check and
  // this UPDATE, we match 0 rows — and for pay-now we REFUND the succeeded
  // PaymentIntent instead of leaving money attached to a dead booking.
  let dbLinked = false;
  let appointmentId: string | null = existingStripe?.id ?? null;
  try {
    const { rows, rowCount } = await sql<{ id: string }>`
      UPDATE appointments
      SET stripe_customer_id = ${stripeCustomerId},
          payment_timing = ${paymentTiming},
          stripe_payment_intent_id = COALESCE(
            ${paymentIntentId},
            stripe_payment_intent_id
          ),
          status = 'confirmed'
      WHERE cal_event_id = ${calBookingUid}
        AND (status IS NULL OR status = 'pending')
      RETURNING id::text AS id
    `;
    dbLinked = (rowCount ?? 0) > 0;
    appointmentId = rows[0]?.id ?? appointmentId;
    if (!dbLinked) {
      // Lost the race (release/cancel/another confirm won) or row vanished.
      const current = await getAppointmentStripeByCalUid(calBookingUid);
      const currentStatus = (current?.status || '').toLowerCase();

      if (currentStatus === 'confirmed') {
        const matchesLinkedIntent = paymentIntentId
          ? (current?.stripe_payment_intent_id ?? '').trim() ===
            paymentIntentId
          : (current?.stripe_setup_intent_id ?? '').trim() === setupIntentId;
        if (matchesLinkedIntent) {
          // Concurrent duplicate of the same confirm — the other request
          // completed the promote. Report success.
          return NextResponse.json({
            ok: true,
            alreadyConfirmed: true,
            stripeCustomerId,
            dbLinked: true,
            cal_accept_error: null,
            notifications: null,
            contact: { sms: false, email: hasRealBookingEmail(email) },
          });
        }
      }

      // Booking is gone/canceled and we hold a captured payment — refund it.
      if (paymentIntentId) {
        try {
          await stripe.refunds.create({ payment_intent: paymentIntentId });
          console.error(
            '[api/booking/confirm] hold lost after payment — refunded',
            { calBookingUid, paymentIntentId, currentStatus }
          );
          return NextResponse.json(
            {
              error: 'hold_lost_after_payment',
              message:
                'Your booking hold expired before we could confirm it, so your payment has been fully refunded. Please pick a new time.',
            },
            { status: 409 }
          );
        } catch (refundErr) {
          console.error(
            '[api/booking/confirm] hold-lost refund FAILED — needs manual review',
            { calBookingUid, paymentIntentId, error: errorMessage(refundErr) }
          );
          return NextResponse.json(
            {
              error: 'hold_lost_after_payment',
              message:
                'Your booking hold expired before we could confirm it. Please contact the studio — your payment will be refunded.',
            },
            { status: 409 }
          );
        }
      }

      console.error(
        '[api/booking/confirm] appointments row not promotable after hold gate',
        { calBookingUid, stripeCustomerId, currentStatus: currentStatus || null }
      );
      return NextResponse.json(
        {
          error: 'booking_not_confirmable',
          message:
            'This booking can no longer be confirmed. Please pick a new time on the calendar.',
          stripeCustomerId,
        },
        { status: 409 }
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] appointments UPDATE failed:', msg);
    return NextResponse.json(
      {
        error: 'db_update_failed',
        message: msg,
        stripeCustomerId,
      },
      { status: 500 }
    );
  }

  if (
    paymentTiming === 'pay_now' &&
    paymentIntentId &&
    appointmentId &&
    payNowAmountCents != null &&
    payNowAmountCents >= 50
  ) {
    try {
      await insertOnlinePrepaidSettlement({
        appointmentId,
        calBookingUid,
        stripePaymentIntentId: paymentIntentId,
        baseAmountCents: payNowAmountCents,
      });
    } catch (err) {
      if (!isSettlementUniqueConflict(err)) {
        console.error(
          '[api/booking/confirm] online prepaid ledger insert failed',
          errorMessage(err)
        );
        return NextResponse.json(
          {
            error: 'prepaid_ledger_failed',
            message:
              'Payment succeeded but we could not record the settlement. Please contact the studio.',
            stripeCustomerId,
            paymentIntentId,
          },
          { status: 500 }
        );
      }
    }
  }

  // ── 4. CAL.COM: accept the pending booking ─────────────────────────
  // Local DB is already 'confirmed'. Sync upstream so Cal's UI +
  // attendee-facing status match. Failures are logged and surfaced as
  // a non-blocking warning — never roll back Stripe or Postgres.
  let calError: string | null = null;
  try {
    calError = await acceptOnCal(calBookingUid);
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] unexpected Cal accept error', {
      calBookingUid,
      error: msg,
    });
    calError = `Could not reach Cal.com (${msg})`;
  }

  // ── 5. NOTIFICATIONS: SMS + reminder emails (after card vaulted) ───
  // Non-blocking: Stripe + DB already succeeded. Idempotent via
  // webhook_events. SMS only when sms_opt_in === true (A2P).
  let notifications: Record<string, unknown> | null = null;
  let contactSms = false;
  let contactEmail = false;
  try {
    const { rows } = await sql<{
      booking_time: Date | string | null;
      end_time: Date | string | null;
      service_name: string | null;
      client_phone: string | null;
      client_email: string | null;
      client_first_name: string | null;
      client_last_name: string | null;
      client_id: string | null;
      sms_opt_in: boolean | null;
    }>`
      SELECT booking_time, end_time, service_name, client_phone, client_email,
             client_first_name, client_last_name, client_id, sms_opt_in
      FROM appointments
      WHERE cal_event_id = ${calBookingUid}
      LIMIT 1
    `;
    const appt = rows[0];
    if (appt) {
      let smsOptIn = appt.sms_opt_in === true;

      // Race: confirm can beat the Cal webhook that writes sms_opt_in.
      // Hydrate once from Cal when the column is still null.
      if (appt.sms_opt_in == null) {
        try {
          const apiKey =
            process.env.CALCOM_API_KEY?.trim() ||
            process.env.CAL_API_KEY?.trim();
          if (apiKey) {
            const calRes = await fetch(
              `${CAL_V2_BASE}/bookings/${encodeURIComponent(calBookingUid)}`,
              {
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'cal-api-version': CAL_BOOKINGS_API_VERSION,
                  Accept: 'application/json',
                },
              }
            );
            if (calRes.ok) {
              const calJson = (await calRes.json()) as {
                data?: {
                  bookingFieldsResponses?: Record<string, unknown>;
                  responses?: Record<string, unknown>;
                };
              };
              const fields =
                calJson.data?.bookingFieldsResponses ||
                calJson.data?.responses ||
                {};
              const raw =
                fields['sms-consent'] ??
                fields.smsConsent ??
                fields.sms_consent;
              const hydrated =
                raw === true ||
                raw === 'true' ||
                raw === 1 ||
                raw === '1' ||
                (typeof raw === 'object' &&
                  raw !== null &&
                  (raw as { value?: unknown }).value === true);
              smsOptIn = hydrated;
              await sql`
                UPDATE appointments
                SET sms_opt_in = ${hydrated}
                WHERE cal_event_id = ${calBookingUid}
                  AND sms_opt_in IS NULL
              `;
            }
          }
        } catch (hydrateErr) {
          console.warn(
            '[api/booking/confirm] sms_opt_in hydrate from Cal failed',
            errorMessage(hydrateErr)
          );
        }
      }

      const bookingTime =
        appt.booking_time instanceof Date
          ? appt.booking_time.toISOString()
          : appt.booking_time
            ? String(appt.booking_time)
            : null;
      const endTime =
        appt.end_time instanceof Date
          ? appt.end_time.toISOString()
          : appt.end_time
            ? String(appt.end_time)
            : null;
      const clientName = [appt.client_first_name, appt.client_last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      const resolvedEmail = appt.client_email || email || null;
      contactSms = smsOptIn;
      contactEmail = hasRealBookingEmail(resolvedEmail);
      notifications = await notifyBookingConfirmed({
        bookingUid: calBookingUid,
        bookingTime,
        endTime,
        clientPhone: appt.client_phone || '',
        clientName: clientName || name,
        serviceName: appt.service_name || 'appointment',
        clientId: appt.client_id,
        clientEmail: resolvedEmail,
        skipIfAlreadySent: true,
        smsOptIn,
      });
    } else {
      console.warn(
        '[api/booking/confirm] no appointment row for notifications',
        { calBookingUid }
      );
      contactEmail = hasRealBookingEmail(email);
    }
  } catch (err) {
    console.error('[api/booking/confirm] notifications failed (non-blocking)', {
      calBookingUid,
      error: errorMessage(err),
    });
    if (!contactEmail) contactEmail = hasRealBookingEmail(email);
  }

  await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
    service: analyticsServiceLabel(hold.service_name),
  });

  return NextResponse.json({
    ok: true,
    stripeCustomerId,
    dbLinked,
    // Null on the happy path; populated when Cal's accept call failed
    // but Stripe + DB succeeded. The UI can show "card saved — admin
    // will confirm shortly" so the client isn't left wondering.
    cal_accept_error: calError,
    notifications,
    contact: {
      sms: contactSms,
      email: contactEmail,
    },
  });
}
