/**
 * POST /api/qstash/review-request
 *
 * Delayed Google-review SMS (~30 minutes after a confirmed visit ends).
 * Scheduled from notifyBookingConfirmed / reschedule / ensure-reminders /
 * admin profile PATCH when “Ask after next visit” is turned back on.
 *
 * Always 200 on logical skips so QStash does not retry. The send path
 * still requires sms_opt_in and clients.review_request_pending.
 */

import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';

import { fulfillReviewRequestForBooking } from '@/lib/booking-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey) {
    console.error(
      '[api/qstash/review-request] QSTASH_CURRENT_SIGNING_KEY missing — refusing'
    );
    return NextResponse.json(
      { error: 'signing_key_not_configured' },
      { status: 500 }
    );
  }

  const signature = req.headers.get('upstash-signature');
  if (!signature) {
    console.warn('[api/qstash/review-request] missing upstash-signature header');
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      console.warn('[api/qstash/review-request] invalid upstash signature');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
  } catch (err) {
    console.error('[api/qstash/review-request] signature verify failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'signature_verify_failed' },
      { status: 401 }
    );
  }

  let bookingUid = '';
  let expectedBookingTime: string | null = null;
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    if (parsed && typeof parsed === 'object') {
      const uid = (parsed as { bookingUid?: unknown }).bookingUid;
      if (typeof uid === 'string') bookingUid = uid.trim();
      const expected = (parsed as { expectedBookingTime?: unknown })
        .expectedBookingTime;
      if (typeof expected === 'string' && expected.trim()) {
        expectedBookingTime = expected.trim();
      }
    }
  } catch {
    return NextResponse.json(
      { ok: true, skipped: 'invalid_json_body' },
      { status: 200 }
    );
  }

  if (!bookingUid) {
    return NextResponse.json(
      { ok: true, skipped: 'missing_booking_uid' },
      { status: 200 }
    );
  }

  const result = await fulfillReviewRequestForBooking({
    bookingUid,
    expectedBookingTime,
  });
  return NextResponse.json(result, { status: 200 });
}
