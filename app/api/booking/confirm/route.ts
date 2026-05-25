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
 *
 * Cal.com sync (tried in order):
 *   1. PATCH v1 `/bookings/<uid>?apiKey=…` with `{ status: 'ACCEPTED' }`
 *      — same pattern as `/api/cron/cleanup-abandoned` rejectOnCal.
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
  getAppointmentStripeByCalUid,
  STRIPE_CUSTOMER_ID_RE,
} from '@/lib/appointment-stripe';
import { HOLD_EXPIRED_MESSAGE, isHoldExpired } from '@/lib/booking-hold';
import { stripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CAL_V1_BASE = 'https://api.cal.com/v1';
const CAL_V2_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
interface ConfirmBody {
  setupIntentId?: unknown;
  email?: unknown;
  name?: unknown;
  calBookingUid?: unknown;
}

interface ParsedBody {
  setupIntentId: string;
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

function isUsableEmail(value: string): boolean {
  return value.length > 0 && value.includes('@') && value.length <= 254;
}

function parseBody(input: unknown): ParsedBody | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body' };
  }
  const body = input as ConfirmBody;
  const setupIntentId =
    typeof body.setupIntentId === 'string' ? body.setupIntentId.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';

  if (!setupIntentId.startsWith('seti_')) {
    return { error: 'invalid_setup_intent_id' };
  }
  if (!calBookingUid || calBookingUid.length > 200) {
    return { error: 'invalid_cal_booking_uid' };
  }

  // name + email are OPTIONAL in the request. We pass through only
  // values that pass a loose sanity check — anything obviously broken
  // gets dropped so the PaymentMethod's billing_details (which the
  // visitor just typed into the card form) can take over.
  const email = isUsableEmail(rawEmail) ? rawEmail : '';
  const name = rawName.length > 0 && rawName.length <= 200 ? rawName : '';

  return { setupIntentId, email, name, calBookingUid };
}

function calErrorMessage(payload: unknown, status: number): string {
  return (
    (payload && typeof payload === 'object'
      ? ((payload as { message?: string; error?: string }).message ??
        (payload as { message?: string; error?: string }).error)
      : null) ?? `HTTP ${status}`
  );
}

/**
 * Accept a pending booking on Cal.com so it leaves "Unconfirmed".
 * Returns null on success, or a human-readable error for the UI.
 *
 * Tries v1 PATCH first (matches cleanup cron), then v2 confirm
 * (matches cancel-booking.js) because some accounts only honour
 * one of the two surfaces for uid-based bookings.
 */
async function acceptOnCal(calEventId: string): Promise<string | null> {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error(
      '[api/booking/confirm] CAL_API_KEY not set — skipping Cal accept'
    );
    return 'CAL_API_KEY not configured on the server';
  }

  // ── v1: PATCH { status: 'ACCEPTED' } (cleanup cron pattern) ───────
  try {
    const v1 = await fetch(
      `${CAL_V1_BASE}/bookings/${encodeURIComponent(calEventId)}?apiKey=${encodeURIComponent(apiKey)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ status: 'ACCEPTED' }),
      }
    );

    if (v1.ok) {
      console.log('[api/booking/confirm] Cal v1 accept succeeded', {
        calEventId,
      });
      return null;
    }

    const v1Payload = await v1.json().catch(() => null);
    const v1Message = calErrorMessage(v1Payload, v1.status);
    console.warn('[api/booking/confirm] Cal v1 PATCH failed — trying v2', {
      calEventId,
      status: v1.status,
      message: v1Message,
    });
  } catch (err) {
    console.warn('[api/booking/confirm] Cal v1 PATCH network error — trying v2', {
      calEventId,
      error: errorMessage(err),
    });
  }

  // ── v2: POST /bookings/:uid/confirm (cancel-booking.js pattern) ───
  try {
    const v2 = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(calEventId)}/confirm`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    if (v2.ok) {
      console.log('[api/booking/confirm] Cal v2 confirm succeeded', {
        calEventId,
      });
      return null;
    }

    const v2Payload = await v2.json().catch(() => null);
    const v2Message = calErrorMessage(v2Payload, v2.status);
    console.error('[api/booking/confirm] Cal v2 confirm failed', {
      calEventId,
      status: v2.status,
      message: v2Message,
    });
    return `Cal.com rejected the confirmation (${v2Message})`;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] Cal v2 confirm network error', {
      calEventId,
      error: msg,
    });
    return `Could not reach Cal.com (${msg})`;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
  const { setupIntentId, email, name, calBookingUid } = parsed;

  // ── 0. HOLD GATE — abort if the abandoned-cart sweep released the slot ─
  try {
    const hold = await getAppointmentHoldByCalUid(calBookingUid);
    if (hold) {
      const status = (hold.status || '').toLowerCase();
      if (status === 'canceled_by_system' || isHoldExpired(hold.created_at)) {
        return NextResponse.json(
          {
            error: 'cart_hold_expired',
            message: HOLD_EXPIRED_MESSAGE,
          },
          { status: 400 }
        );
      }
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] hold lookup failed:', msg);
    return NextResponse.json(
      { error: 'hold_lookup_failed', message: msg },
      { status: 500 }
    );
  }

  // ── 1. STRIPE: verify SetupIntent succeeded ────────────────────────
  // We expand `payment_method` so the SDK returns the full
  // PaymentMethod object (including `billing_details`) instead of just
  // its id. That extra fetch is free vs a follow-up
  // `paymentMethods.retrieve` call and lets us derive name + email
  // when the URL didn't carry them (Cal.com's `bookingSuccessful`
  // payload doesn't always include attendee info — older embed.js
  // versions omit `attendees` entirely, and a Cal account on the
  // free tier can't customise what's emitted).
  let paymentMethodId: string;
  let pmBilling: {
    name: string | null;
    email: string | null;
  } = { name: null, email: null };
  let setupIntent: Awaited<
    ReturnType<NonNullable<typeof stripe>['setupIntents']['retrieve']>
  >;
  try {
    setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
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
    // After expansion, `payment_method` is the full object. Type guard
    // both shapes so a future refactor that drops the expand call
    // doesn't silently break the billing-details fallback.
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
    if (!paymentMethodId) {
      return NextResponse.json(
        { error: 'no_payment_method_on_setup_intent' },
        { status: 400 }
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] setupIntents.retrieve failed:', msg);
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
    email || (pmBilling.email && isUsableEmail(pmBilling.email.trim())
      ? pmBilling.email.trim()
      : '');
  const resolvedName =
    name ||
    (pmBilling.name && pmBilling.name.trim().length > 0
      ? pmBilling.name.trim().slice(0, 200)
      : '');

  // ── 2. STRIPE: attach PaymentMethod to vault Customer ─────────────
  const existingStripe = await getAppointmentStripeByCalUid(calBookingUid);
  const customerFromIntent =
    typeof setupIntent.customer === 'string'
      ? setupIntent.customer
      : setupIntent.customer &&
          typeof setupIntent.customer === 'object' &&
          'id' in setupIntent.customer &&
          typeof setupIntent.customer.id === 'string'
        ? setupIntent.customer.id
        : null;

  let stripeCustomerId =
    (customerFromIntent && STRIPE_CUSTOMER_ID_RE.test(customerFromIntent)
      ? customerFromIntent
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
  // WHERE-clause guard: only promote rows that are currently 'pending'
  // OR have no status yet (legacy rows that predate the state machine).
  // This avoids two problem cases:
  //   • A duplicate /checkout submission for the same uid clobbering
  //     a row that's since transitioned to 'no-show' or 'canceled_*'.
  //   • A late client finishing /checkout AFTER McKenna already
  //     manually cancelled the booking — we don't want to silently
  //     un-cancel it. The customer_id still updates (Stripe charged
  //     them — the link is real) but the calendar status stays where
  //     the admin put it.
  //
  // If the row doesn't exist yet (the webhook hasn't fired by the
  // time the client finishes /checkout — race possible on slow
  // networks), we still want to report "vaulted, not yet linked"
  // rather than fail outright. The webhook handler can backfill
  // by stripe_customer_id later via metadata lookup if needed.
  let dbLinked = false;
  try {
    const { rowCount } = await sql`
      UPDATE appointments
      SET stripe_customer_id = ${stripeCustomerId},
          status = CASE
            WHEN status IS NULL OR status = 'pending' THEN 'confirmed'
            ELSE status
          END
      WHERE cal_event_id = ${calBookingUid}
    `;
    dbLinked = (rowCount ?? 0) > 0;
    if (!dbLinked) {
      console.warn(
        '[api/booking/confirm] no appointments row matched cal_event_id — webhook may not have run yet',
        { calBookingUid, stripeCustomerId }
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/confirm] appointments UPDATE failed:', msg);
    return NextResponse.json(
      {
        error: 'db_update_failed',
        message: msg,
        // Surface the Stripe Customer id so the admin can manually
        // reconcile if needed — we don't want to silently lose a
        // valid vault behind a DB error.
        stripeCustomerId,
      },
      { status: 500 }
    );
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

  return NextResponse.json({
    ok: true,
    stripeCustomerId,
    dbLinked,
    // Null on the happy path; populated when Cal's accept call failed
    // but Stripe + DB succeeded. The UI can show "card saved — admin
    // will confirm shortly" so the client isn't left wondering.
    cal_accept_error: calError,
  });
}
