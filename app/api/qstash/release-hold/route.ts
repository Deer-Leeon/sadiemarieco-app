/**
 * POST /api/qstash/release-hold
 *
 * QStash delayed callback scheduled by `/api/booking/init` when a pending
 * checkout hold is created. After CHECKOUT_HOLD_MINUTES, verifies the
 * Upstash signature and releases the Cal slot + local row if still pending.
 *
 * Always returns 200 on logical skips (already confirmed / canceled) so
 * QStash does not retry. Returns 5xx only for misconfiguration or
 * transient Cal failures worth retrying.
 */

import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';

import { releaseAbandonedHoldByCalUid } from '@/lib/release-abandoned-hold';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey) {
    console.error(
      '[api/qstash/release-hold] QSTASH_CURRENT_SIGNING_KEY missing — refusing'
    );
    return NextResponse.json(
      { error: 'signing_key_not_configured' },
      { status: 500 }
    );
  }

  const signature = req.headers.get('upstash-signature');
  if (!signature) {
    console.warn('[api/qstash/release-hold] missing upstash-signature header');
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      console.warn('[api/qstash/release-hold] invalid upstash signature');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
  } catch (err) {
    console.error('[api/qstash/release-hold] signature verify failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'signature_verify_failed' }, { status: 401 });
  }

  let calBookingUid = '';
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    if (parsed && typeof parsed === 'object') {
      const uid = (parsed as { calBookingUid?: unknown }).calBookingUid;
      if (typeof uid === 'string') calBookingUid = uid.trim();
    }
  } catch {
    return NextResponse.json(
      { ok: true, skipped: 'invalid_json_body' },
      { status: 200 }
    );
  }

  if (!calBookingUid) {
    return NextResponse.json(
      { ok: true, skipped: 'missing_cal_booking_uid' },
      { status: 200 }
    );
  }

  const result = await releaseAbandonedHoldByCalUid(calBookingUid);

  if (!result.ok) {
    if (result.retryable) {
      console.error('[api/qstash/release-hold] retryable failure', result);
      return NextResponse.json(
        { ok: false, reason: result.reason },
        { status: 500 }
      );
    }
    console.error('[api/qstash/release-hold] non-retryable failure', result);
    return NextResponse.json(
      { ok: true, skipped: result.reason },
      { status: 200 }
    );
  }

  if (result.released) {
    console.log('[api/qstash/release-hold] released abandoned hold', {
      appointmentId: result.appointmentId,
      calBookingUid: result.calBookingUid,
    });
  }

  return NextResponse.json(result, { status: 200 });
}
