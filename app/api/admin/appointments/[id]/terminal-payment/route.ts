import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { getSucceededAppointmentPayment } from '@/lib/appointment-settlement';
import {
  claimTerminalReader,
  clearStaleReaderAction,
  countTerminalAttempts,
  findTerminalAppointment,
  getLatestTerminalPayment,
  getTerminalConfiguration,
  insertTerminalPayment,
  isAmbiguousTerminalError,
  isValidAppointmentId,
  isTerminalReaderLockConflict,
  markTerminalPaymentFailure,
  processTerminalPayment,
  reassignTerminalPaymentReader,
  reconcileTerminalPayment,
  syncTerminalPaymentFromStripe,
  terminalErrorDetails,
  validateConfiguredTerminalReader,
} from '@/lib/stripe-terminal';
import {
  applyTerminalDiscount,
  isTerminalDiscountPercent,
  isValidTerminalCustomAmountCents,
  terminalCustomAmountNote,
  terminalDiscountNote,
  type TerminalDiscountPercent,
} from '@/lib/terminal-discount';
import { stripeCardPresentStatementFields } from '@/lib/stripe-statement-descriptor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string }>;
}
function authError(reason: string): NextResponse {
  return NextResponse.json(
    { error: reason },
    { status: reason === 'unauthenticated' ? 401 : 403 }
  );
}

export async function POST(
  req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let discountPercent: TerminalDiscountPercent = 0;
  let customAmountCents: number | null = null;
  try {
    const body = (await req.json().catch(() => null)) as {
      discount_percent?: unknown;
      custom_amount_cents?: unknown;
    } | null;
    if (body?.custom_amount_cents !== undefined) {
      if (!isValidTerminalCustomAmountCents(body.custom_amount_cents)) {
        return NextResponse.json(
          {
            error: 'invalid_custom_amount',
            message:
              'Custom amount must be between $0.50 and $10,000.00.',
          },
          { status: 400 }
        );
      }
      customAmountCents = body.custom_amount_cents;
    } else if (body?.discount_percent !== undefined) {
      if (!isTerminalDiscountPercent(body.discount_percent)) {
        return NextResponse.json(
          {
            error: 'invalid_discount',
            message: 'Discount must be 0%, 10%, 20%, or 50%.',
          },
          { status: 400 }
        );
      }
      discountPercent = body.discount_percent;
    }
  } catch {
    // Empty / non-JSON body → full price (backward compatible).
  }

  const terminal = getTerminalConfiguration();
  if (!terminal.ok) {
    return NextResponse.json(
      { error: terminal.error, message: terminal.message },
      { status: terminal.status }
    );
  }

  try {
    const readerValidation = await validateConfiguredTerminalReader(
      terminal.stripe,
      terminal.config
    );
    if (!readerValidation.ok) {
      return NextResponse.json(
        {
          error: readerValidation.error,
          message: readerValidation.message,
        },
        { status: readerValidation.status }
      );
    }

    const appointment = await findTerminalAppointment(id);
    if (!appointment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if ((appointment.status || '').toLowerCase() !== 'confirmed') {
      return NextResponse.json(
        {
          error: 'appointment_not_chargeable',
          message: 'Only confirmed appointments can be charged in person.',
        },
        { status: 409 }
      );
    }

    const quotedRaw = Number(appointment.quoted_service_price_cents);
    const quotedCents = Number.isSafeInteger(quotedRaw) ? quotedRaw : 0;

    let amountCents: number;
    let amountNote: string | null = null;
    if (customAmountCents != null) {
      amountCents = customAmountCents;
      amountNote = terminalCustomAmountNote(customAmountCents, quotedCents);
    } else {
      if (quotedCents < 50) {
        return NextResponse.json(
          {
            error: 'service_price_unavailable',
            message:
              'This appointment does not have a valid quoted service price and cannot be charged automatically.',
          },
          { status: 409 }
        );
      }
      amountCents = applyTerminalDiscount(quotedCents, discountPercent);
      if (amountCents < 50) {
        return NextResponse.json(
          {
            error: 'discount_below_minimum',
            message:
              'That discount brings the charge below Stripe’s $0.50 minimum. Choose a smaller discount.',
          },
          { status: 409 }
        );
      }
      amountNote = terminalDiscountNote(discountPercent);
    }

    const succeeded = await getSucceededAppointmentPayment(appointment.id);
    if (succeeded) {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This appointment has already been paid.',
          payment: succeeded,
        },
        { status: 409 }
      );
    }

    let existing = await getLatestTerminalPayment(appointment.id);

    // Reconcile an "active" row against Stripe first — a prior reader cancel
    // can leave pending/processing until we sync.
    if (
      existing &&
      (existing.status === 'pending' || existing.status === 'processing') &&
      existing.payment_intent_id &&
      existing.reader_id
    ) {
      try {
        const reconciled = await reconcileTerminalPayment({
          stripe: terminal.stripe,
          readerId: existing.reader_id,
          paymentIntentId: existing.payment_intent_id,
        });
        if (reconciled.payment) existing = reconciled.payment;
      } catch {
        // Keep the DB snapshot; conflict handling below still applies.
      }
    }

    if (existing?.status === 'pending' || existing?.status === 'processing') {
      return NextResponse.json(
        {
          error: 'payment_in_progress',
          message:
            'A Terminal payment is already active for this appointment.',
          payment: existing,
        },
        { status: 409 }
      );
    }

    // Prior failed attempt: re-send the same PaymentIntent when the amount
    // still matches (don't bounce the UI with a stale cancel error). If staff
    // changed the amount, abandon the old PI and create a fresh one below.
    if (
      existing?.status === 'failed' &&
      existing.payment_intent_id &&
      existing.base_amount_cents === amountCents
    ) {
      try {
        await clearStaleReaderAction(terminal.stripe, terminal.config.readerId, {
          paymentIntentId: existing.payment_intent_id,
        });
        if (existing.reader_id !== terminal.config.readerId) {
          await reassignTerminalPaymentReader(
            existing.payment_intent_id,
            terminal.config.readerId
          );
        }
        try {
          await claimTerminalReader(existing.payment_intent_id);
        } catch (err) {
          if (!isTerminalReaderLockConflict(err)) throw err;
          return NextResponse.json(
            {
              error: 'terminal_reader_busy',
              message:
                'The S710 is already collecting another appointment payment. Finish or cancel that payment first.',
              payment: existing,
            },
            { status: 409 }
          );
        }
        const processed = await processTerminalPayment({
          stripe: terminal.stripe,
          readerId: terminal.config.readerId,
          paymentIntentId: existing.payment_intent_id,
          amountEligibleCents: amountCents,
        });
        return NextResponse.json({
          payment: processed.payment,
          reader: {
            id: processed.reader.id,
            label: processed.reader.label,
            status: processed.reader.status,
            action_status: processed.reader.action?.status ?? null,
          },
        });
      } catch (err) {
        const detail = terminalErrorDetails(err);
        try {
          const reconciled = await reconcileTerminalPayment({
            stripe: terminal.stripe,
            readerId: terminal.config.readerId,
            paymentIntentId: existing.payment_intent_id,
          });
          if (
            reconciled.payment?.status === 'succeeded' ||
            reconciled.payment?.status === 'processing'
          ) {
            return NextResponse.json({
              payment: reconciled.payment,
              reader: reconciled.reader
                ? {
                    id: reconciled.reader.id,
                    label: reconciled.reader.label,
                    status: reconciled.reader.status,
                    action_status: reconciled.reader.action?.status ?? null,
                  }
                : null,
            });
          }
        } catch {
          // Fall through to mark failure.
        }
        if (isAmbiguousTerminalError(detail.code)) {
          return NextResponse.json(
            {
              error: detail.code,
              message:
                'The reader request may still be active. Status will keep checking before another payment can start.',
              payment: await getLatestTerminalPayment(appointment.id),
            },
            { status: 502 }
          );
        }
        const payment = await markTerminalPaymentFailure(
          existing.payment_intent_id,
          detail.code,
          detail.message
        );
        return NextResponse.json(
          {
            error: detail.code,
            message: detail.message,
            payment,
          },
          { status: detail.code === 'terminal_reader_busy' ? 409 : 502 }
        );
      }
    }

    if (existing?.status === 'failed' && existing.payment_intent_id) {
      try {
        await clearStaleReaderAction(terminal.stripe, terminal.config.readerId, {
          paymentIntentId: existing.payment_intent_id,
        });
        const intent = await terminal.stripe.paymentIntents.retrieve(
          existing.payment_intent_id
        );
        if (
          intent.status !== 'succeeded' &&
          intent.status !== 'canceled' &&
          intent.status !== 'processing'
        ) {
          const canceled = await terminal.stripe.paymentIntents.cancel(
            intent.id,
            { cancellation_reason: 'abandoned' }
          );
          await syncTerminalPaymentFromStripe(canceled);
        } else {
          await syncTerminalPaymentFromStripe(intent);
        }
      } catch (err) {
        console.warn(
          '[terminal-payment] could not abandon failed intent before restart',
          terminalErrorDetails(err)
        );
      }
    }

    const attemptNumber = (await countTerminalAttempts(appointment.id)) + 1;
    const serviceLabel =
      appointment.service_name?.split(' between ')[0]?.trim() ||
      'Studio service';
    const intent = await terminal.stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        ...stripeCardPresentStatementFields,
        description: `${serviceLabel} — in-person appointment payment`,
        ...(appointment.client_email
          ? { receipt_email: appointment.client_email }
          : {}),
        metadata: {
          appointment_id: appointment.id,
          cal_booking_uid: appointment.cal_booking_uid || '',
          payment_kind: 'service_payment',
          service_label: serviceLabel.slice(0, 500),
          quoted_service_price_cents: String(quotedCents),
          discount_percent:
            customAmountCents != null ? 'custom' : String(discountPercent),
          charge_amount_cents: String(amountCents),
          ...(customAmountCents != null
            ? { custom_amount_cents: String(customAmountCents) }
            : {}),
        },
      },
      {
        idempotencyKey: `terminal-service:${appointment.id}:${attemptNumber}`,
      }
    );

    try {
      await insertTerminalPayment({
        appointmentId: appointment.id,
        calBookingUid: appointment.cal_booking_uid,
        paymentIntentId: intent.id,
        readerId: terminal.config.readerId,
        currency: intent.currency,
        amountCents,
        note: amountNote,
      });
    } catch (err) {
      if (!isTerminalReaderLockConflict(err)) throw err;
      try {
        await terminal.stripe.paymentIntents.cancel(intent.id, {
          cancellation_reason: 'abandoned',
        });
      } catch {
        // The unprocessed intent is harmless; preserve the useful busy response.
      }
      return NextResponse.json(
        {
          error: 'terminal_reader_busy',
          message:
            'The S710 is already collecting another appointment payment. Finish or cancel that payment first.',
        },
        { status: 409 }
      );
    }

    try {
      const processed = await processTerminalPayment({
        stripe: terminal.stripe,
        readerId: terminal.config.readerId,
        paymentIntentId: intent.id,
        amountEligibleCents: amountCents,
      });
      return NextResponse.json({
        payment: processed.payment,
        reader: {
          id: processed.reader.id,
          label: processed.reader.label,
          status: processed.reader.status,
          action_status: processed.reader.action?.status ?? null,
        },
      });
    } catch (err) {
      const detail = terminalErrorDetails(err);
      try {
        const reconciled = await reconcileTerminalPayment({
          stripe: terminal.stripe,
          readerId: terminal.config.readerId,
          paymentIntentId: intent.id,
        });
        if (
          reconciled.payment?.status === 'succeeded' ||
          reconciled.payment?.status === 'processing'
        ) {
          return NextResponse.json({
            payment: reconciled.payment,
            reader: reconciled.reader
              ? {
                  id: reconciled.reader.id,
                  label: reconciled.reader.label,
                  status: reconciled.reader.status,
                  action_status: reconciled.reader.action?.status ?? null,
                }
              : null,
          });
        }
      } catch {
        // Preserve the original reader error when reconciliation also fails.
      }
      if (isAmbiguousTerminalError(detail.code)) {
        return NextResponse.json(
          {
            error: detail.code,
            message:
              'The reader request may still be active. Status will keep checking before another payment can start.',
            payment: await getLatestTerminalPayment(appointment.id),
          },
          { status: 502 }
        );
      }
      const payment = await markTerminalPaymentFailure(
        intent.id,
        detail.code,
        detail.message
      );
      return NextResponse.json(
        {
          error: detail.code,
          message: detail.message,
          payment,
        },
        { status: detail.code === 'terminal_reader_busy' ? 409 : 502 }
      );
    }
  } catch (err) {
    const detail = terminalErrorDetails(err);
    console.error('[terminal-payment] start failed', detail);
    return NextResponse.json(
      { error: detail.code, message: detail.message },
      { status: 500 }
    );
  }
}
export async function GET(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const terminal = getTerminalConfiguration();
  if (!terminal.ok) {
    return NextResponse.json(
      { error: terminal.error, message: terminal.message },
      { status: terminal.status }
    );
  }

  try {
    const payment = await getLatestTerminalPayment(id);
    if (!payment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (!payment.reader_id || !payment.payment_intent_id) {
      return NextResponse.json({
        payment,
        reader: null,
      });
    }

    const reconciled = await reconcileTerminalPayment({
      stripe: terminal.stripe,
      readerId: payment.reader_id,
      paymentIntentId: payment.payment_intent_id,
    });
    if (!reconciled.reader) {
      return NextResponse.json(
        {
          error: 'reader_deleted',
          message: 'The configured Terminal reader has been deleted.',
          payment,
        },
        { status: 409 }
      );
    }

    const reader = reconciled.reader;

    return NextResponse.json({
      payment: reconciled.payment ?? payment,
      reader: {
        id: reader.id,
        label: reader.label,
        status: reader.status,
        action_status: reader.action?.status ?? null,
      },
    });
  } catch (err) {
    const detail = terminalErrorDetails(err);
    console.error('[terminal-payment] status failed', detail);
    return NextResponse.json(
      { error: detail.code, message: detail.message },
      { status: 502 }
    );
  }
}
