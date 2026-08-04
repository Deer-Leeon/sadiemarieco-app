import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { getSucceededAppointmentPayment } from '@/lib/appointment-settlement';
import {
  claimTerminalReader,
  findTerminalAppointment,
  getLatestTerminalPayment,
  getTerminalConfiguration,
  isAmbiguousTerminalError,
  isValidAppointmentId,
  isTerminalReaderLockConflict,
  markTerminalPaymentFailure,
  processTerminalPayment,
  reconcileTerminalPayment,
  reassignTerminalPaymentReader,
  syncTerminalPaymentFromStripe,
  terminalErrorDetails,
  validateConfiguredTerminalReader,
} from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string }>;
}
export async function POST(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

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

    const [appointment, payment, succeeded] = await Promise.all([
      findTerminalAppointment(id),
      getLatestTerminalPayment(id),
      getSucceededAppointmentPayment(id),
    ]);
    if (!appointment || !payment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (succeeded && succeeded.payment_kind !== 'service_payment') {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This appointment has already been settled.',
          payment: succeeded,
        },
        { status: 409 }
      );
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
    if (payment.status === 'succeeded' || payment.status === 'canceled') {
      return NextResponse.json(
        {
          error:
            payment.status === 'succeeded' ? 'already_paid' : 'payment_canceled',
          message:
            payment.status === 'succeeded'
              ? 'This appointment has already been paid.'
              : 'Start a new payment for this canceled attempt.',
          payment,
        },
        { status: 409 }
      );
    }
    if (payment.status === 'pending' || payment.status === 'processing') {
      return NextResponse.json(
        {
          error: 'payment_in_progress',
          message: 'This payment is already active on the reader.',
          payment,
        },
        { status: 409 }
      );
    }

    if (!payment.reader_id || !payment.payment_intent_id) {
      return NextResponse.json(
        {
          error: 'not_a_terminal_payment',
          message: 'This settlement was not collected on the Terminal.',
          payment,
        },
        { status: 409 }
      );
    }

    const paymentIntentId = payment.payment_intent_id;
    const intent = await terminal.stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge'] }
    );
    if (intent.status === 'succeeded' || intent.status === 'canceled') {
      const synced = await syncTerminalPaymentFromStripe(intent);
      return NextResponse.json({ payment: synced ?? payment });
    }
    if (intent.status === 'processing') {
      const synced = await syncTerminalPaymentFromStripe(intent);
      return NextResponse.json({ payment: synced ?? payment });
    }

    let retryReaderId = payment.reader_id;
    if (retryReaderId !== terminal.config.readerId) {
      await reassignTerminalPaymentReader(
        paymentIntentId,
        terminal.config.readerId
      );
      retryReaderId = terminal.config.readerId;
    }

    try {
      await claimTerminalReader(paymentIntentId);
    } catch (err) {
      if (!isTerminalReaderLockConflict(err)) throw err;
      return NextResponse.json(
        {
          error: 'terminal_reader_busy',
          message:
            'The S710 is already collecting another appointment payment. Finish or cancel that payment first.',
          payment,
        },
        { status: 409 }
      );
    }

    try {
      const processed = await processTerminalPayment({
        stripe: terminal.stripe,
        readerId: retryReaderId,
        paymentIntentId,
        amountEligibleCents: payment.base_amount_cents,
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
          readerId: retryReaderId,
          paymentIntentId,
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
        // Preserve the original process error when reconciliation also fails.
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
      const failed = await markTerminalPaymentFailure(
        paymentIntentId,
        detail.code,
        detail.message
      );
      return NextResponse.json(
        {
          error: detail.code,
          message: detail.message,
          payment: failed ?? payment,
        },
        { status: detail.code === 'terminal_reader_busy' ? 409 : 502 }
      );
    }
  } catch (err) {
    const detail = terminalErrorDetails(err);
    console.error('[terminal-payment] retry failed', detail);
    return NextResponse.json(
      { error: detail.code, message: detail.message },
      { status: 500 }
    );
  }
}
