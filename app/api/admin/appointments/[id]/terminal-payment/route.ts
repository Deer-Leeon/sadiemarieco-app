import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
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
  reconcileTerminalPayment,
  terminalErrorDetails,
  validateConfiguredTerminalReader,
} from '@/lib/stripe-terminal';

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

    const amountCents = Number(appointment.quoted_service_price_cents);
    if (!Number.isSafeInteger(amountCents) || amountCents < 50) {
      return NextResponse.json(
        {
          error: 'service_price_unavailable',
          message:
            'This appointment does not have a valid quoted service price and cannot be charged automatically.',
        },
        { status: 409 }
      );
    }

    const existing = await getLatestTerminalPayment(appointment.id);
    if (existing?.status === 'succeeded') {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This appointment has already been paid.',
          payment: existing,
        },
        { status: 409 }
      );
    }
    if (existing && existing.status !== 'canceled') {
      return NextResponse.json(
        {
          error:
            existing.status === 'failed'
              ? 'retry_required'
              : 'payment_in_progress',
          message:
            existing.status === 'failed'
              ? 'This payment is ready to retry on the reader.'
              : 'A Terminal payment is already active for this appointment.',
          payment: existing,
        },
        { status: 409 }
      );
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
        description: `${serviceLabel} — in-person appointment payment`,
        ...(appointment.client_email
          ? { receipt_email: appointment.client_email }
          : {}),
        metadata: {
          appointment_id: appointment.id,
          cal_booking_uid: appointment.cal_booking_uid || '',
          payment_kind: 'service_payment',
          service_label: serviceLabel.slice(0, 500),
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
