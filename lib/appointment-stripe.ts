import { sql } from '@vercel/postgres';

export const STRIPE_CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
export const STRIPE_SETUP_INTENT_ID_RE = /^seti_[A-Za-z0-9]+$/;
export const STRIPE_PAYMENT_INTENT_ID_RE = /^pi_[A-Za-z0-9_]+$/;

export type BookingPaymentTiming = 'pay_later' | 'pay_now';

export function isBookingPaymentTiming(
  value: unknown
): value is BookingPaymentTiming {
  return value === 'pay_later' || value === 'pay_now';
}

export interface AppointmentStripeRow {
  stripe_customer_id: string | null;
  stripe_setup_intent_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_timing: string | null;
  quoted_service_price_cents: number | null;
  status: string | null;
  id: string | null;
}

export async function getAppointmentStripeByCalUid(
  calBookingUid: string
): Promise<AppointmentStripeRow | null> {
  const { rows } = await sql<AppointmentStripeRow>`
    SELECT
      id::text AS id,
      stripe_customer_id,
      stripe_setup_intent_id,
      stripe_payment_intent_id,
      payment_timing,
      quoted_service_price_cents,
      status
    FROM appointments
    WHERE cal_event_id = ${calBookingUid}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Persist in-progress SetupIntent on a pending row only. Do not write
 * `stripe_customer_id` until /api/booking/confirm succeeds — otherwise CRM
 * shows "card on file" before checkout completes.
 */
export async function saveAppointmentStripeSetupIntent(params: {
  calBookingUid: string;
  stripeSetupIntentId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE appointments
    SET stripe_setup_intent_id = ${params.stripeSetupIntentId}
    WHERE cal_event_id = ${params.calBookingUid}
      AND (status IS NULL OR status = 'pending')
  `;
  return (rowCount ?? 0) > 0;
}

export async function saveAppointmentStripePaymentIntent(params: {
  calBookingUid: string;
  stripePaymentIntentId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE appointments
    SET stripe_payment_intent_id = ${params.stripePaymentIntentId}
    WHERE cal_event_id = ${params.calBookingUid}
      AND (status IS NULL OR status = 'pending')
  `;
  return (rowCount ?? 0) > 0;
}

/** @deprecated Use saveAppointmentStripeSetupIntent — customer id is set at confirm. */
export async function saveAppointmentStripeVault(params: {
  calBookingUid: string;
  stripeCustomerId: string;
  stripeSetupIntentId: string;
}): Promise<boolean> {
  return saveAppointmentStripeSetupIntent({
    calBookingUid: params.calBookingUid,
    stripeSetupIntentId: params.stripeSetupIntentId,
  });
}
