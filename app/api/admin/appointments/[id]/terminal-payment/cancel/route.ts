import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  getLatestTerminalPayment,
  getTerminalConfiguration,
  isValidAppointmentId,
  syncTerminalPaymentFromStripe,
  terminalErrorDetails,
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
    const payment = await getLatestTerminalPayment(id);
    if (!payment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (payment.status === 'succeeded') {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'A completed payment cannot be canceled here.',
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

    const readerId = payment.reader_id;
    const paymentIntentId = payment.payment_intent_id;

    const reader = await terminal.stripe.terminal.readers.retrieve(readerId);
    if (!('deleted' in reader && reader.deleted)) {
      const actionIntent =
        reader.action?.process_payment_intent?.payment_intent ?? null;
      const actionIntentId =
        typeof actionIntent === 'string' ? actionIntent : actionIntent?.id;
      if (
        reader.action?.status === 'in_progress' &&
        actionIntentId === paymentIntentId
      ) {
        try {
          await terminal.stripe.terminal.readers.cancelAction(readerId);
        } catch (err) {
          const detail = terminalErrorDetails(err);
          if (detail.code !== 'terminal_reader_busy') throw err;
          return NextResponse.json(
            {
              error: detail.code,
              message:
                'The reader is authorizing the card right now. Check status before trying to cancel again.',
              payment,
            },
            { status: 409 }
          );
        }
      }
    }

    let intent = await terminal.stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge'] }
    );
    if (
      intent.status !== 'succeeded' &&
      intent.status !== 'canceled' &&
      intent.status !== 'processing'
    ) {
      intent = await terminal.stripe.paymentIntents.cancel(intent.id, {
        cancellation_reason: 'abandoned',
      });
    }
    const synced = await syncTerminalPaymentFromStripe(intent);
    return NextResponse.json({ payment: synced ?? payment });
  } catch (err) {
    const detail = terminalErrorDetails(err);
    console.error('[terminal-payment] cancel failed', detail);
    return NextResponse.json(
      { error: detail.code, message: detail.message },
      { status: 502 }
    );
  }
}
