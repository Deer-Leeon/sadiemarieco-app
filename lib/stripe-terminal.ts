import 'server-only';

import { sql } from '@vercel/postgres';
import type Stripe from 'stripe';

import type {
  TerminalPaymentStatus,
  TerminalPaymentSummary,
} from '@/app/admin/types';
import {
  type AppointmentPaymentRow,
  paymentRowToSummary,
} from '@/lib/appointment-settlement';
import { stripe } from '@/lib/stripe';
import {
  getStripeEnvModes,
  shouldEnforceStripeMode,
  stripeModeMismatchMessage,
} from '@/lib/stripe-mode';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TerminalAppointment {
  id: string;
  cal_booking_uid: string | null;
  status: string | null;
  service_name: string | null;
  quoted_service_price_cents: number | null;
  stripe_customer_id: string | null;
  client_email: string | null;
}

type PaymentRow = AppointmentPaymentRow;

export interface TerminalConfiguration {
  readerId: string;
  locationId: string;
}

export type TerminalConfigResult =
  | { ok: true; stripe: Stripe; config: TerminalConfiguration }
  | { ok: false; status: number; error: string; message: string };

export function getTerminalConfiguration(): TerminalConfigResult {
  if (!stripe) {
    return {
      ok: false,
      status: 503,
      error: 'stripe_not_configured',
      message: 'Stripe is not configured on this deployment.',
    };
  }

  const modes = getStripeEnvModes();
  if (shouldEnforceStripeMode() && !modes.matchesExpected) {
    return {
      ok: false,
      status: 503,
      error: 'stripe_mode_mismatch',
      message: stripeModeMismatchMessage(modes),
    };
  }

  const readerId = process.env.STRIPE_TERMINAL_READER_ID?.trim() || '';
  if (!/^tmr_[A-Za-z0-9_]+$/.test(readerId)) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_reader_not_configured',
      message:
        'STRIPE_TERMINAL_READER_ID is missing or invalid for this deployment.',
    };
  }

  const locationId =
    process.env.STRIPE_TERMINAL_LOCATION_ID?.trim() || '';
  if (!/^tml_[A-Za-z0-9_]+$/.test(locationId)) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_location_invalid',
      message: 'STRIPE_TERMINAL_LOCATION_ID is missing or invalid.',
    };
  }

  return { ok: true, stripe, config: { readerId, locationId } };
}

export type TerminalReaderValidation =
  | { ok: true; reader: Stripe.Terminal.Reader }
  | { ok: false; status: number; error: string; message: string };

export async function validateConfiguredTerminalReader(
  client: Stripe,
  config: TerminalConfiguration
): Promise<TerminalReaderValidation> {
  const reader = await client.terminal.readers.retrieve(config.readerId);
  if ('deleted' in reader && reader.deleted) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_reader_deleted',
      message: 'The configured Stripe Terminal reader has been deleted.',
    };
  }

  const actualLocation =
    typeof reader.location === 'string'
      ? reader.location
      : reader.location?.id || null;
  if (actualLocation !== config.locationId) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_location_mismatch',
      message:
        'The configured S710 is not assigned to the configured Terminal location.',
    };
  }

  const expectedMode = getStripeEnvModes().expected;
  if ((reader.livemode ? 'live' : 'test') !== expectedMode) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_reader_mode_mismatch',
      message: `The configured reader is not in Stripe ${expectedMode} mode.`,
    };
  }

  if (reader.status !== 'online') {
    return {
      ok: false,
      status: 409,
      error: 'terminal_reader_offline',
      message: 'The S710 is offline. Reconnect it before starting a payment.',
    };
  }

  return { ok: true, reader };
}

function parseIntegerId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function isValidAppointmentId(raw: string): boolean {
  return UUID_RE.test(raw) || parseIntegerId(raw) !== null;
}

export async function findTerminalAppointment(
  idParam: string
): Promise<TerminalAppointment | null> {
  if (!isValidAppointmentId(idParam)) return null;

  // Compare the canonical text form so UUID and legacy integer schemas share
  // one query and therefore cannot drift in service-price resolution.
  const { rows } = await sql<TerminalAppointment>`
    SELECT
      a.id::text AS id,
      a.cal_event_id AS cal_booking_uid,
      a.status,
      a.service_name,
      a.stripe_customer_id,
      a.client_email,
      a.quoted_service_price_cents
    FROM appointments a
    WHERE a.id::text = ${idParam}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLatestTerminalPayment(
  appointmentId: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql<PaymentRow>`
    SELECT
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
    FROM appointment_payments
    WHERE appointment_id = ${appointmentId}
      AND payment_kind = 'service_payment'
    ORDER BY
      CASE WHEN status = 'succeeded' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `;
  return rows[0] ? paymentRowToSummary(rows[0]) : null;
}

export async function getTerminalPaymentByIntent(
  paymentIntentId: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql<PaymentRow>`
    SELECT
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
    FROM appointment_payments
    WHERE stripe_payment_intent_id = ${paymentIntentId}
    LIMIT 1
  `;
  return rows[0] ? paymentRowToSummary(rows[0]) : null;
}

export async function countTerminalAttempts(
  appointmentId: string
): Promise<number> {
  const { rows } = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM appointment_payments
    WHERE appointment_id = ${appointmentId}
      AND payment_kind = 'service_payment'
  `;
  return Number(rows[0]?.count || 0);
}

export async function insertTerminalPayment(args: {
  appointmentId: string;
  calBookingUid: string | null;
  paymentIntentId: string;
  readerId: string;
  currency: string;
  amountCents: number;
}): Promise<TerminalPaymentSummary> {
  const { rows } = await sql<PaymentRow>`
    INSERT INTO appointment_payments (
      appointment_id,
      cal_booking_uid,
      stripe_payment_intent_id,
      stripe_reader_id,
      currency,
      base_amount_cents,
      total_amount_cents,
      status
    )
    VALUES (
      ${args.appointmentId},
      ${args.calBookingUid},
      ${args.paymentIntentId},
      ${args.readerId},
      ${args.currency},
      ${args.amountCents},
      ${args.amountCents},
      'pending'
    )
    ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
      updated_at = NOW()
    RETURNING
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
  `;
  return paymentRowToSummary(rows[0]);
}

export async function claimTerminalReader(
  paymentIntentId: string
): Promise<TerminalPaymentSummary> {
  const { rows } = await sql<PaymentRow>`
    UPDATE appointment_payments
    SET
      status = 'pending',
      failure_code = NULL,
      failure_message = NULL,
      updated_at = NOW()
    WHERE stripe_payment_intent_id = ${paymentIntentId}
      AND status <> 'succeeded'
      AND status <> 'canceled'
    RETURNING
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
  `;
  if (!rows[0]) {
    throw new Error('Terminal payment is no longer retryable.');
  }
  return paymentRowToSummary(rows[0]);
}

export async function reassignTerminalPaymentReader(
  paymentIntentId: string,
  readerId: string
): Promise<TerminalPaymentSummary> {
  const { rows } = await sql<PaymentRow>`
    UPDATE appointment_payments
    SET
      stripe_reader_id = ${readerId},
      updated_at = NOW()
    WHERE stripe_payment_intent_id = ${paymentIntentId}
      AND status = 'failed'
    RETURNING
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
  `;
  if (!rows[0]) {
    throw new Error('Only a failed Terminal payment can move to a new reader.');
  }
  return paymentRowToSummary(rows[0]);
}

export function isTerminalReaderLockConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const value = err as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    cause?: {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
  };
  const code = value.code ?? value.cause?.code;
  const constraint = value.constraint ?? value.cause?.constraint;
  const message =
    typeof value.message === 'string'
      ? value.message
      : typeof value.cause?.message === 'string'
        ? value.cause.message
        : '';
  return (
    code === '23505' &&
    (constraint === 'appointment_payments_one_active_reader_idx' ||
      message.includes('appointment_payments_one_active_reader_idx'))
  );
}

function paymentStateFromStripe(
  intent: Stripe.PaymentIntent,
  readerAction?: Stripe.Terminal.Reader['action']
): {
  status: TerminalPaymentStatus;
  failureCode: string | null;
  failureMessage: string | null;
} {
  if (intent.status === 'succeeded') {
    return { status: 'succeeded', failureCode: null, failureMessage: null };
  }
  if (intent.status === 'canceled') {
    return { status: 'canceled', failureCode: null, failureMessage: null };
  }
  if (
    intent.status === 'processing' ||
    readerAction?.status === 'in_progress'
  ) {
    return { status: 'processing', failureCode: null, failureMessage: null };
  }
  if (readerAction?.status === 'failed' || intent.last_payment_error) {
    return {
      status: 'failed',
      failureCode:
        readerAction?.failure_code ||
        intent.last_payment_error?.code ||
        intent.last_payment_error?.decline_code ||
        'payment_failed',
      failureMessage:
        readerAction?.failure_message ||
        intent.last_payment_error?.message ||
        'The payment could not be completed.',
    };
  }
  return { status: 'pending', failureCode: null, failureMessage: null };
}

export async function syncTerminalPaymentFromStripe(
  intent: Stripe.PaymentIntent,
  readerAction?: Stripe.Terminal.Reader['action']
): Promise<TerminalPaymentSummary | null> {
  const state = paymentStateFromStripe(intent, readerAction);
  const tipAmount = Math.max(0, intent.amount_details?.tip?.amount || 0);
  // Keep total = base + tip so the settlement amounts check stays valid.
  const paidAt =
    state.status === 'succeeded'
      ? new Date(
          ((intent.latest_charge &&
          typeof intent.latest_charge !== 'string' &&
          intent.latest_charge.created
            ? intent.latest_charge.created
            : Math.floor(Date.now() / 1000)) as number) * 1000
        ).toISOString()
      : null;

  const { rows } = await sql<PaymentRow>`
    UPDATE appointment_payments
    SET
      status = CASE
        WHEN status IN ('succeeded', 'canceled') THEN status
        ELSE ${state.status}
      END,
      currency = ${intent.currency.toLowerCase()},
      tip_amount_cents = ${tipAmount},
      total_amount_cents = base_amount_cents + ${tipAmount},
      failure_code = ${state.failureCode},
      failure_message = ${state.failureMessage},
      paid_at = CASE
        WHEN status IN ('succeeded', 'canceled') THEN paid_at
        WHEN ${state.status} = 'succeeded' THEN ${paidAt}
        ELSE paid_at
      END,
      updated_at = NOW()
    WHERE stripe_payment_intent_id = ${intent.id}
    RETURNING
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
  `;
  return rows[0] ? paymentRowToSummary(rows[0]) : null;
}

export async function markTerminalPaymentFailure(
  paymentIntentId: string,
  code: string,
  message: string
): Promise<TerminalPaymentSummary | null> {
  const { rows } = await sql<PaymentRow>`
    UPDATE appointment_payments
    SET
      status = CASE
        WHEN status IN ('succeeded', 'canceled') THEN status
        ELSE 'failed'
      END,
      failure_code = CASE
        WHEN status IN ('succeeded', 'canceled') THEN failure_code
        ELSE ${code}
      END,
      failure_message = CASE
        WHEN status IN ('succeeded', 'canceled') THEN failure_message
        ELSE ${message}
      END,
      updated_at = NOW()
    WHERE stripe_payment_intent_id = ${paymentIntentId}
    RETURNING
      id,
      appointment_id,
      cal_booking_uid,
      payment_kind,
      stripe_payment_intent_id,
      stripe_reader_id,
      status,
      currency,
      base_amount_cents,
      tip_amount_cents,
      total_amount_cents,
      failure_code,
      failure_message,
      note,
      settled_by_email,
      paid_at
  `;
  return rows[0] ? paymentRowToSummary(rows[0]) : null;
}

export async function processTerminalPayment(args: {
  stripe: Stripe;
  readerId: string;
  paymentIntentId: string;
  amountEligibleCents: number;
}): Promise<{
  reader: Stripe.Terminal.Reader;
  payment: TerminalPaymentSummary | null;
}> {
  const reader = await args.stripe.terminal.readers.processPaymentIntent(
    args.readerId,
    {
      payment_intent: args.paymentIntentId,
      process_config: {
        enable_customer_cancellation: true,
        allow_redisplay: 'unspecified',
        tipping: { amount_eligible: args.amountEligibleCents },
      },
    }
  );
  let payment = await getTerminalPaymentByIntent(args.paymentIntentId);
  try {
    const intent = await args.stripe.paymentIntents.retrieve(
      args.paymentIntentId,
      { expand: ['latest_charge'] }
    );
    payment = await syncTerminalPaymentFromStripe(intent, reader.action);
  } catch (err) {
    // The reader accepted the action, so keep the DB row active and let the
    // status poll/webhook reconcile it. Never release the reader lock merely
    // because the follow-up retrieve timed out.
    console.warn('[stripe-terminal] post-process reconciliation deferred', {
      paymentIntentId: args.paymentIntentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    reader,
    payment,
  };
}

export async function reconcileTerminalPayment(args: {
  stripe: Stripe;
  readerId: string;
  paymentIntentId: string;
}): Promise<{
  payment: TerminalPaymentSummary | null;
  reader: Stripe.Terminal.Reader | null;
}> {
  const [intent, readerResult] = await Promise.all([
    args.stripe.paymentIntents.retrieve(args.paymentIntentId, {
      expand: ['latest_charge'],
    }),
    args.stripe.terminal.readers.retrieve(args.readerId),
  ]);
  const reader =
    'deleted' in readerResult && readerResult.deleted ? null : readerResult;
  const actionIntent =
    reader?.action?.process_payment_intent?.payment_intent ?? null;
  const actionIntentId =
    typeof actionIntent === 'string' ? actionIntent : actionIntent?.id;
  const action =
    actionIntentId === args.paymentIntentId ? reader?.action : null;
  return {
    payment: await syncTerminalPaymentFromStripe(intent, action),
    reader,
  };
}

export function terminalErrorDetails(err: unknown): {
  code: string;
  message: string;
} {
  if (err && typeof err === 'object') {
    const candidate = err as {
      code?: unknown;
      message?: unknown;
      raw?: { code?: unknown; message?: unknown };
    };
    return {
      code:
        (typeof candidate.code === 'string' && candidate.code) ||
        (typeof candidate.raw?.code === 'string' && candidate.raw.code) ||
        'terminal_error',
      message:
        (typeof candidate.message === 'string' && candidate.message) ||
        (typeof candidate.raw?.message === 'string' &&
          candidate.raw.message) ||
        'Stripe Terminal could not complete the request.',
    };
  }
  return { code: 'terminal_error', message: String(err) };
}

export function isAmbiguousTerminalError(code: string): boolean {
  return (
    code === 'api_connection_error' ||
    code === 'api_error' ||
    code === 'timeout' ||
    code === 'terminal_error'
  );
}
