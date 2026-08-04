import { NextResponse } from 'next/server';
import type Stripe from 'stripe';

import { stripe } from '@/lib/stripe';
import { syncTerminalPaymentFromStripe } from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TERMINAL_READER_EVENTS = new Set([
  'terminal.reader.action_succeeded',
  'terminal.reader.action_failed',
  'terminal.reader.action_updated',
]);

const PAYMENT_INTENT_EVENTS = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.processing',
]);

function readerPaymentIntentId(
  reader: Stripe.Terminal.Reader
): string | null {
  const value = reader.action?.process_payment_intent?.payment_intent;
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
export async function POST(req: Request): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json(
      { error: 'stripe_not_configured' },
      { status: 503 }
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is missing');
    return NextResponse.json(
      { error: 'webhook_not_configured' },
      { status: 503 }
    );
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(),
      signature,
      webhookSecret
    );
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed', err);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    if (PAYMENT_INTENT_EVENTS.has(event.type)) {
      const snapshot = event.data.object as Stripe.PaymentIntent;
      const intent = await stripe.paymentIntents.retrieve(snapshot.id, {
        expand: ['latest_charge'],
      });
      await syncTerminalPaymentFromStripe(intent);
    } else if (TERMINAL_READER_EVENTS.has(event.type)) {
      const reader = event.data.object as Stripe.Terminal.Reader;
      const paymentIntentId = readerPaymentIntentId(reader);
      if (paymentIntentId) {
        const [intent, currentReader] = await Promise.all([
          stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['latest_charge'],
          }),
          stripe.terminal.readers.retrieve(reader.id),
        ]);
        const currentAction =
          'deleted' in currentReader && currentReader.deleted
            ? null
            : currentReader.action;
        const currentActionIntent =
          currentAction?.process_payment_intent?.payment_intent ?? null;
        const currentActionIntentId =
          typeof currentActionIntent === 'string'
            ? currentActionIntent
            : currentActionIntent?.id;
        await syncTerminalPaymentFromStripe(
          intent,
          currentActionIntentId === paymentIntentId ? currentAction : null
        );
      }
    }
  } catch (err) {
    // Returning 500 asks Stripe to retry. DB writes are idempotent.
    console.error('[stripe-webhook] event processing failed', {
      eventId: event.id,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
