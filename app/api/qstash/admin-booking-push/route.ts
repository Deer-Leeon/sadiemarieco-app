/**
 * POST /api/qstash/admin-booking-push
 *
 * Attempt N (N ≥ 2) of an admin iOS booking alert: retries the tokens that
 * failed on the previous attempt (or reloads registered devices when none
 * were registered yet). The chain re-queues itself with growing delays and
 * gives up after `ADMIN_PUSH_MAX_ATTEMPTS`. Signature-gated like other
 * QStash workers.
 *
 * 200 → attempt handled (sent, re-queued, or exhausted; QStash must not
 *       retry this message).
 * 503 → nothing sent AND the next attempt could not be queued; QStash's own
 *       retries re-deliver this same attempt.
 */
import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';

import { runAdminPushRetry } from '@/lib/admin-booking-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey) {
    console.error(
      '[api/qstash/admin-booking-push] QSTASH_CURRENT_SIGNING_KEY missing'
    );
    return NextResponse.json(
      { error: 'signing_key_not_configured' },
      { status: 500 }
    );
  }

  const signature = req.headers.get('upstash-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
  } catch (err) {
    console.error('[api/qstash/admin-booking-push] signature verify failed', {
      error: errorMessage(err),
    });
    return NextResponse.json(
      { error: 'signature_verify_failed' },
      { status: 401 }
    );
  }

  let parsed: unknown = {};
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  } catch {
    return NextResponse.json({ ok: true, skipped: 'invalid_json' });
  }

  const result = await runAdminPushRetry({
    body: parsed,
    requestHost: req.headers.get('x-forwarded-host') || req.headers.get('host'),
  });

  if (result.status !== 200) {
    return NextResponse.json(
      { error: 'apns_retryable', sent: result.sent, skipped: result.skipped },
      { status: result.status }
    );
  }
  return NextResponse.json({
    ok: true,
    sent: result.sent,
    skipped: result.skipped,
    retryScheduled: result.retryScheduled,
  });
}
