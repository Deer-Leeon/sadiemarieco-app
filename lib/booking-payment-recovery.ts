/**
 * Stripe webhook reconciliation for ONLINE pay-now booking payments.
 *
 * Safety net for the gap where `stripe.confirmPayment()` succeeds in the
 * browser but `POST /api/booking/confirm` never lands (network drop, tab
 * closed, server error). Without this, money is captured while the local
 * hold later expires and releases the slot.
 *
 * Driven by `payment_intent.succeeded` events (metadata.cal_booking_uid +
 * metadata.payment_timing === 'pay_now'; Terminal PIs carry neither):
 *
 *   • appointment still `pending`  → promote to confirmed (same atomic
 *     pending-only UPDATE as /api/booking/confirm), attach the card,
 *     write the prepaid ledger row, accept on Cal, send notifications.
 *     Everything is idempotent with the confirm route, so whichever of
 *     the two runs first wins and the other becomes a no-op.
 *   • appointment `canceled_by_system` (hold-release won a race)
 *     → refund the full payment.
 *   • any other status → leave alone (cancel/no-show penalties are the
 *     Cal webhook's and admin routes' job).
 */

import type Stripe from 'stripe';
import { sql } from '@vercel/postgres';

import {
  getAppointmentStripeByCalUid,
  STRIPE_CUSTOMER_ID_RE,
} from '@/lib/appointment-stripe';
import {
  insertOnlinePrepaidSettlement,
  isSettlementUniqueConflict,
} from '@/lib/appointment-settlement';
import { notifyBookingConfirmed } from '@/lib/booking-notifications';
import { acceptOnCal } from '@/lib/cal-accept';
import { CAL_BOOKINGS_API_VERSION } from '@/lib/cal-proxy';
import { stripe } from '@/lib/stripe';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function intentCustomerId(intent: Stripe.PaymentIntent): string | null {
  const c = intent.customer;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && 'id' in c && typeof c.id === 'string') {
    return c.id;
  }
  return null;
}

function intentPaymentMethodId(intent: Stripe.PaymentIntent): string | null {
  const pm = intent.payment_method;
  if (typeof pm === 'string') return pm;
  if (pm && typeof pm === 'object' && typeof pm.id === 'string') return pm.id;
  return null;
}

export async function reconcileSucceededBookingPayment(
  intent: Stripe.PaymentIntent
): Promise<void> {
  if (!stripe) return;
  if (intent.status !== 'succeeded') return;

  const calBookingUid = (intent.metadata?.cal_booking_uid ?? '').trim();
  const timing = (intent.metadata?.payment_timing ?? '').trim();
  if (!calBookingUid || timing !== 'pay_now') return;

  const row = await getAppointmentStripeByCalUid(calBookingUid);
  if (!row) {
    console.error(
      '[booking-payment-recovery] succeeded PI has no appointment row',
      { calBookingUid, paymentIntentId: intent.id }
    );
    return;
  }

  const status = (row.status || '').toLowerCase();

  // Hold-release beat the payment — the slot is gone; give the money back.
  if (status === 'canceled_by_system') {
    try {
      await stripe.refunds.create({ payment_intent: intent.id });
      console.error(
        '[booking-payment-recovery] refunded payment on released hold',
        { calBookingUid, paymentIntentId: intent.id }
      );
    } catch (err) {
      const msg = errorMessage(err);
      if (/already.*refunded/i.test(msg)) return;
      console.error(
        '[booking-payment-recovery] refund on released hold FAILED — needs manual review',
        { calBookingUid, paymentIntentId: intent.id, error: msg }
      );
    }
    return;
  }

  if (status && status !== 'pending') return;

  const linkedPi = (row.stripe_payment_intent_id ?? '').trim();
  if (linkedPi && linkedPi !== intent.id) {
    // A newer payment session superseded this PI; the confirm route's
    // duplicate handling owns that case.
    return;
  }

  const stripeCustomerId = intentCustomerId(intent);

  const { rows: promoted } = await sql<{ id: string }>`
    UPDATE appointments
    SET status = 'confirmed',
        payment_timing = 'pay_now',
        stripe_payment_intent_id = ${intent.id},
        stripe_customer_id = COALESCE(${stripeCustomerId}, stripe_customer_id)
    WHERE cal_event_id = ${calBookingUid}
      AND (status IS NULL OR status = 'pending')
    RETURNING id::text AS id
  `;
  if (promoted.length === 0) {
    // Confirm route (or a concurrent webhook delivery) won — done.
    return;
  }
  const appointmentId = promoted[0].id;
  console.log(
    '[booking-payment-recovery] promoted paid booking that missed confirm',
    { calBookingUid, paymentIntentId: intent.id, appointmentId }
  );

  // Vault the card for later no-show/late-cancel policy (best-effort).
  const paymentMethodId = intentPaymentMethodId(intent);
  if (
    stripeCustomerId &&
    STRIPE_CUSTOMER_ID_RE.test(stripeCustomerId) &&
    paymentMethodId
  ) {
    try {
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
      console.warn(
        '[booking-payment-recovery] card vault attach failed (non-blocking)',
        { calBookingUid, error: errorMessage(err) }
      );
    }
  }

  if (intent.amount >= 50) {
    try {
      await insertOnlinePrepaidSettlement({
        appointmentId,
        calBookingUid,
        stripePaymentIntentId: intent.id,
        baseAmountCents: intent.amount,
      });
    } catch (err) {
      if (!isSettlementUniqueConflict(err)) {
        console.error(
          '[booking-payment-recovery] prepaid ledger insert failed',
          { calBookingUid, error: errorMessage(err) }
        );
      }
    }
  }

  try {
    const calError = await acceptOnCal(calBookingUid);
    if (calError) {
      console.error('[booking-payment-recovery] Cal accept failed', {
        calBookingUid,
        calError,
      });
    }
  } catch (err) {
    console.error('[booking-payment-recovery] Cal accept threw', {
      calBookingUid,
      error: errorMessage(err),
    });
  }

  // Notifications — idempotent via webhook_events, same as confirm.
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
    if (!appt) return;

    // Same race as /api/booking/confirm: this can beat the Cal webhook that
    // writes sms_opt_in. Hydrate once from Cal when the column is still null
    // so opted-in clients don't silently miss their confirmation SMS.
    let smsOptIn = appt.sms_opt_in === true;
    if (appt.sms_opt_in == null) {
      try {
        const apiKey =
          process.env.CALCOM_API_KEY?.trim() || process.env.CAL_API_KEY?.trim();
        if (apiKey) {
          const calRes = await fetch(
            `https://api.cal.com/v2/bookings/${encodeURIComponent(calBookingUid)}`,
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
            const rawConsent =
              fields['sms-consent'] ?? fields.smsConsent ?? fields.sms_consent;
            smsOptIn =
              rawConsent === true ||
              rawConsent === 'true' ||
              rawConsent === 1 ||
              rawConsent === '1' ||
              (typeof rawConsent === 'object' &&
                rawConsent !== null &&
                (rawConsent as { value?: unknown }).value === true);
            await sql`
              UPDATE appointments
              SET sms_opt_in = ${smsOptIn}
              WHERE cal_event_id = ${calBookingUid}
                AND sms_opt_in IS NULL
            `;
          }
        }
      } catch (hydrateErr) {
        console.warn(
          '[booking-payment-recovery] sms_opt_in hydrate from Cal failed',
          errorMessage(hydrateErr)
        );
      }
    }

    const toIso = (v: Date | string | null): string | null =>
      v instanceof Date ? v.toISOString() : v ? String(v) : null;
    const clientName = [appt.client_first_name, appt.client_last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    await notifyBookingConfirmed({
      bookingUid: calBookingUid,
      bookingTime: toIso(appt.booking_time),
      endTime: toIso(appt.end_time),
      clientPhone: appt.client_phone || '',
      clientName,
      serviceName: appt.service_name || 'appointment',
      clientId: appt.client_id,
      clientEmail: appt.client_email,
      skipIfAlreadySent: true,
      smsOptIn: appt.sms_opt_in === true,
    });
  } catch (err) {
    console.error(
      '[booking-payment-recovery] notifications failed (non-blocking)',
      { calBookingUid, error: errorMessage(err) }
    );
  }
}
