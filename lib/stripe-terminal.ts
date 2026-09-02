import 'server-only';

import { sql } from '@vercel/postgres';
import type Stripe from 'stripe';

import type {
  TerminalPaymentStatus,
  TerminalPaymentSummary,
} from '@/app/admin/types';
import {
  type AppointmentPaymentRow,
  isSettlementUniqueConflict,
  paymentRowToSummary,
} from '@/lib/appointment-settlement';
import { splitChargeAcrossQuoted } from '@/lib/same-day-unsettled';
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

  // Match the reader to the secret key in use (not deployment "expected"
  // mode). Local `next-dev` defaults expected→test so day-to-day work stays
  // safe, but live keys in `.env.local` must be able to talk to the live S710.
  const modes = getStripeEnvModes();
  const readerMode = reader.livemode ? 'live' : 'test';
  const requiredMode =
    modes.secret === 'live' || modes.secret === 'test'
      ? modes.secret
      : modes.expected;
  if (readerMode !== requiredMode) {
    return {
      ok: false,
      status: 503,
      error: 'terminal_reader_mode_mismatch',
      message: `The configured reader is not in Stripe ${requiredMode} mode.`,
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
  note?: string | null;
  paymentGroupId?: string | null;
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
      status,
      note,
      payment_group_id
    )
    VALUES (
      ${args.appointmentId},
      ${args.calBookingUid},
      ${args.paymentIntentId},
      ${args.readerId},
      ${args.currency},
      ${args.amountCents},
      ${args.amountCents},
      'pending',
      ${args.note ?? null},
      ${args.paymentGroupId ?? null}
    )
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

function groupedAppointmentIdsFromIntent(intent: Stripe.PaymentIntent): string[] {
  const raw = intent.metadata?.appointment_ids?.trim() || '';
  if (!raw) {
    const primary = intent.metadata?.appointment_id?.trim();
    return primary ? [primary] : [];
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

async function fanOutGroupedTerminalSettlements(
  intent: Stripe.PaymentIntent,
  primaryRow: PaymentRow
): Promise<void> {
  if (primaryRow.status !== 'succeeded') return;
  const ids = groupedAppointmentIdsFromIntent(intent);
  if (ids.length <= 1) return;

  const primaryId = intent.metadata?.appointment_id?.trim() || primaryRow.appointment_id;
  const extraIds = ids.filter((id) => id !== primaryId);
  if (extraIds.length === 0) return;

  const existing = await sql<{ appointment_id: string }>`
    SELECT appointment_id
    FROM appointment_payments
    WHERE stripe_payment_intent_id = ${intent.id}
      AND status = 'succeeded'
  `;
  const already = new Set(existing.rows.map((row) => row.appointment_id));
  if (extraIds.every((id) => already.has(id))) return;

  const { rows: quotedRows } = await sql.query(
    `SELECT id::text AS id, quoted_service_price_cents, cal_event_id AS cal_booking_uid
     FROM appointments
     WHERE id::text = ANY($1::text[])`,
    [ids]
  );
  const quotedById = new Map<string, number>();
  const uidById = new Map<string, string | null>();
  for (const row of quotedRows as {
    id: string;
    quoted_service_price_cents: number | null;
    cal_booking_uid: string | null;
  }[]) {
    const raw = Number(row.quoted_service_price_cents);
    quotedById.set(row.id, Number.isSafeInteger(raw) && raw >= 0 ? raw : 0);
    uidById.set(row.id, row.cal_booking_uid);
  }

  const fromMeta = Number(intent.metadata?.charge_amount_cents);
  const combinedBase =
    Number.isSafeInteger(fromMeta) && fromMeta >= 0
      ? fromMeta
      : Number(primaryRow.base_amount_cents);
  const shares = splitChargeAcrossQuoted(
    ids.map((id) => ({ id, quotedCents: quotedById.get(id) ?? 0 })),
    combinedBase,
    primaryId
  );
  const groupId = crypto.randomUUID();
  const tipAmount = Number(primaryRow.tip_amount_cents) || 0;
  const primaryShare = shares.get(primaryId) ?? combinedBase;
  const readerId = primaryRow.stripe_reader_id;
  const paidAt =
    primaryRow.paid_at instanceof Date
      ? primaryRow.paid_at.toISOString()
      : primaryRow.paid_at;

  await sql.query(
    `UPDATE appointment_payments
     SET
       base_amount_cents = $1,
       tip_amount_cents = $2,
       total_amount_cents = $3,
       payment_group_id = COALESCE(payment_group_id, $4::uuid),
       updated_at = NOW()
     WHERE id = $5::uuid`,
    [primaryShare, tipAmount, primaryShare + tipAmount, groupId, primaryRow.id]
  );

  for (const extraId of extraIds) {
    if (already.has(extraId)) continue;
    const share = shares.get(extraId) ?? 0;
    try {
      await sql.query(
        `INSERT INTO appointment_payments (
           appointment_id,
           cal_booking_uid,
           payment_kind,
           stripe_payment_intent_id,
           stripe_reader_id,
           currency,
           base_amount_cents,
           tip_amount_cents,
           total_amount_cents,
           status,
           note,
           payment_group_id,
           paid_at
         )
         VALUES (
           $1, $2, 'service_payment', $3, $4, $5, $6, 0, $6, 'succeeded',
           'Same-day grouped Terminal charge', $7::uuid, $8
         )`,
        [
          extraId,
          uidById.get(extraId) ?? null,
          intent.id,
          readerId,
          primaryRow.currency,
          share,
          groupId,
          paidAt,
        ]
      );
    } catch (err) {
      if (!isSettlementUniqueConflict(err)) throw err;
    }
  }
}

export async function syncTerminalPaymentFromStripe(
  intent: Stripe.PaymentIntent,
  readerAction?: Stripe.Terminal.Reader['action']
): Promise<TerminalPaymentSummary | null> {
  const state = paymentStateFromStripe(intent, readerAction);
  const tipAmount = Math.max(0, intent.amount_details?.tip?.amount || 0);
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

  const primaryId = intent.metadata?.appointment_id?.trim() || null;
  const { rows } = primaryId
    ? await sql.query(
        `UPDATE appointment_payments
         SET
           status = CASE
             WHEN status IN ('succeeded', 'canceled') THEN status
             ELSE $1
           END,
           currency = $2,
           tip_amount_cents = $3,
           total_amount_cents = base_amount_cents + $3,
           failure_code = $4,
           failure_message = $5,
           paid_at = CASE
             WHEN status IN ('succeeded', 'canceled') THEN paid_at
             WHEN $1 = 'succeeded' THEN $6::timestamptz
             ELSE paid_at
           END,
           updated_at = NOW()
         WHERE stripe_payment_intent_id = $7
           AND appointment_id = $8
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
           paid_at`,
        [
          state.status,
          intent.currency.toLowerCase(),
          tipAmount,
          state.failureCode,
          state.failureMessage,
          paidAt,
          intent.id,
          primaryId,
        ]
      )
    : await sql<PaymentRow>`
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

  const row = rows[0] as PaymentRow | undefined;
  if (!row) return null;

  if (state.status === 'succeeded' || row.status === 'succeeded') {
    try {
      await fanOutGroupedTerminalSettlements(intent, row);
    } catch (err) {
      console.error('[terminal] grouped settlement fan-out failed', err);
    }
    const latest = await getLatestTerminalPayment(row.appointment_id);
    if (latest) return latest;
  }

  return paymentRowToSummary(row);
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

/**
 * Clear a failed (or same-intent) leftover reader action so the next
 * `processPaymentIntent` can bind cleanly. Does not interrupt a different
 * appointment's in-progress collection.
 */
export async function clearStaleReaderAction(
  client: Stripe,
  readerId: string,
  opts?: { paymentIntentId?: string }
): Promise<void> {
  try {
    const reader = await client.terminal.readers.retrieve(readerId);
    if ('deleted' in reader && reader.deleted) return;
    const action = reader.action;
    if (!action) return;

    const actionIntent =
      action.process_payment_intent?.payment_intent ?? null;
    const actionIntentId =
      typeof actionIntent === 'string' ? actionIntent : actionIntent?.id;

    const shouldCancel =
      action.status === 'failed' ||
      (action.status === 'in_progress' &&
        Boolean(opts?.paymentIntentId) &&
        actionIntentId === opts?.paymentIntentId);

    if (!shouldCancel) return;

    try {
      await client.terminal.readers.cancelAction(readerId);
    } catch (err) {
      const detail = terminalErrorDetails(err);
      if (
        detail.code === 'terminal_reader_busy' ||
        detail.message.toLowerCase().includes('no action')
      ) {
        return;
      }
      console.warn('[stripe-terminal] clearStaleReaderAction ignored', detail);
    }
  } catch (err) {
    const detail = terminalErrorDetails(err);
    if (detail.code === 'resource_missing') return;
    console.warn(
      '[stripe-terminal] clearStaleReaderAction retrieve failed',
      detail
    );
  }
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
  await clearStaleReaderAction(args.stripe, args.readerId, {
    paymentIntentId: args.paymentIntentId,
  });

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
