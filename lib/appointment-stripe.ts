import { sql } from '@vercel/postgres';

import { hasVaultedStripeCustomer } from '@/lib/client-crm-stats';
import { sqlPhoneVariants } from '@/lib/client-identity';

export const STRIPE_CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
export const STRIPE_SETUP_INTENT_ID_RE = /^seti_[A-Za-z0-9]+$/;

export interface AppointmentStripeRow {
  stripe_customer_id: string | null;
  stripe_setup_intent_id: string | null;
  status: string | null;
}

/**
 * Find a vaulted Stripe customer id for this client from any prior
 * appointment. CRM "card on file" is client-scoped; admin-manual
 * bookings often leave `appointments.stripe_customer_id` null even when
 * the client already vaulted a card on an earlier checkout.
 */
export async function findClientVaultedStripeCustomerId(params: {
  clientId?: string | null;
  clientPhone?: string | null;
}): Promise<string | null> {
  const clientId =
    typeof params.clientId === 'string' && params.clientId.trim()
      ? params.clientId.trim()
      : null;
  const clientPhone =
    typeof params.clientPhone === 'string' && params.clientPhone.trim()
      ? params.clientPhone.trim()
      : null;

  if (clientId) {
    const { rows } = await sql<{ stripe_customer_id: string }>`
      SELECT stripe_customer_id
      FROM appointments
      WHERE client_id = ${clientId}::uuid
        AND stripe_customer_id IS NOT NULL
        AND TRIM(stripe_customer_id) <> ''
        AND LOWER(COALESCE(status, '')) NOT IN ('pending', 'canceled_by_system')
      ORDER BY booking_time DESC NULLS LAST
      LIMIT 1
    `;
    const id = rows[0]?.stripe_customer_id?.trim();
    if (id) return id;
  }

  if (clientPhone) {
    const [phoneV0, phoneV1] = sqlPhoneVariants(clientPhone);
    const { rows } = await sql<{ stripe_customer_id: string }>`
      SELECT stripe_customer_id
      FROM appointments
      WHERE client_phone IS NOT NULL
        AND (
          regexp_replace(client_phone, '\\D', '', 'g') = ${phoneV0}
          OR regexp_replace(client_phone, '\\D', '', 'g') = ${phoneV1}
        )
        AND stripe_customer_id IS NOT NULL
        AND TRIM(stripe_customer_id) <> ''
        AND LOWER(COALESCE(status, '')) NOT IN ('pending', 'canceled_by_system')
      ORDER BY booking_time DESC NULLS LAST
      LIMIT 1
    `;
    const id = rows[0]?.stripe_customer_id?.trim();
    if (id) return id;
  }

  return null;
}

/** This row's vault, or the client's vault from another appointment. */
export async function resolveAppointmentStripeCustomerId(params: {
  stripeCustomerId?: string | null;
  clientId?: string | null;
  clientPhone?: string | null;
}): Promise<string | null> {
  if (hasVaultedStripeCustomer(params.stripeCustomerId ?? null)) {
    return params.stripeCustomerId!.trim();
  }
  return findClientVaultedStripeCustomerId({
    clientId: params.clientId,
    clientPhone: params.clientPhone,
  });
}

/** Persist a resolved vault onto a row that was missing one (manual books). */
export async function backfillAppointmentStripeCustomerId(params: {
  appointmentId: string | number;
  stripeCustomerId: string;
}): Promise<void> {
  const id = params.appointmentId;
  const customerId = params.stripeCustomerId.trim();
  if (!customerId || !STRIPE_CUSTOMER_ID_RE.test(customerId)) return;

  if (typeof id === 'string') {
    await sql`
      UPDATE appointments
      SET stripe_customer_id = ${customerId}
      WHERE id = ${id}::uuid
        AND (
          stripe_customer_id IS NULL
          OR TRIM(stripe_customer_id) = ''
        )
    `;
    return;
  }

  await sql`
    UPDATE appointments
    SET stripe_customer_id = ${customerId}
    WHERE id = ${id}
      AND (
        stripe_customer_id IS NULL
        OR TRIM(stripe_customer_id) = ''
      )
  `;
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
