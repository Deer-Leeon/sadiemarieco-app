import { sql } from '@vercel/postgres';

export const STRIPE_CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
export const STRIPE_SETUP_INTENT_ID_RE = /^seti_[A-Za-z0-9]+$/;

export interface AppointmentStripeRow {
  stripe_customer_id: string | null;
  stripe_setup_intent_id: string | null;
  status: string | null;
}

export async function getAppointmentStripeByCalUid(
  calBookingUid: string
): Promise<AppointmentStripeRow | null> {
  const { rows } = await sql<AppointmentStripeRow>`
    SELECT stripe_customer_id, stripe_setup_intent_id, status
    FROM appointments
    WHERE cal_event_id = ${calBookingUid}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Persist Stripe vault ids on the pending appointment row. Only updates
 * rows still in `pending` (or NULL status) so a late vault attempt cannot
 * clobber a confirmed booking.
 */
export async function saveAppointmentStripeVault(params: {
  calBookingUid: string;
  stripeCustomerId: string;
  stripeSetupIntentId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE appointments
    SET stripe_customer_id = ${params.stripeCustomerId},
        stripe_setup_intent_id = ${params.stripeSetupIntentId}
    WHERE cal_event_id = ${params.calBookingUid}
      AND (status IS NULL OR status = 'pending')
  `;
  return (rowCount ?? 0) > 0;
}
