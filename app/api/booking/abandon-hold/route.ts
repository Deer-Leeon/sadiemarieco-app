/**
 * POST /api/booking/abandon-hold
 *
 * Client-initiated release of a still-active pending hold (back to the
 * calendar, or closing the drawer). Unlike /api/booking/release-hold this
 * does not wait for the 10-minute window — the caller already holds the
 * opaque Cal UID from their own checkout.
 *
 * No abandoned-checkout SMS: they chose to leave, they did not time out.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import { releaseAbandonedHoldByCalUid } from '@/lib/release-abandoned-hold';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `booking:abandon-hold:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookingReleaseHold,
  });
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const uid =
    body &&
    typeof body === 'object' &&
    typeof (body as { calBookingUid?: unknown }).calBookingUid === 'string'
      ? (body as { calBookingUid: string }).calBookingUid.trim()
      : '';

  if (!uid || uid.length > 200) {
    return NextResponse.json(
      { error: 'invalid_cal_booking_uid' },
      { status: 400 }
    );
  }

  try {
    const row = await getAppointmentHoldByCalUid(uid);
    if (!row) {
      return NextResponse.json({
        ok: true,
        released: false,
        skipped: 'not_found',
      });
    }

    const status = (row.status || '').toLowerCase();
    if (status !== 'pending') {
      return NextResponse.json({
        ok: true,
        released: false,
        skipped: `status_${status || 'unknown'}`,
      });
    }

    const result = await releaseAbandonedHoldByCalUid(uid, {
      sendAbandonedSms: false,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'release_failed', reason: result.reason },
        { status: result.retryable ? 502 : 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/booking/abandon-hold] failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'release_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
