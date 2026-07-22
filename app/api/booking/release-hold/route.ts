/**
 * POST /api/booking/release-hold
 *
 * Public release for an expired checkout hold. The Cal booking UID is the
 * same opaque token already in the /checkout URL. Only releases when the
 * local row is still `pending` AND `created_at` is past the hold window —
 * so a visitor cannot free someone else's active hold early.
 *
 * Used by the checkout countdown when it hits 00:00 so the Cal slot opens
 * even if the QStash delayed job never fired.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import { isHoldExpired } from '@/lib/booking-hold';
import { releaseAbandonedHoldByCalUid } from '@/lib/release-abandoned-hold';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
    return NextResponse.json({ error: 'invalid_cal_booking_uid' }, { status: 400 });
  }

  try {
    const row = await getAppointmentHoldByCalUid(uid);
    if (!row) {
      return NextResponse.json({ ok: true, released: false, skipped: 'not_found' });
    }

    const status = (row.status || '').toLowerCase();
    if (status !== 'pending') {
      return NextResponse.json({
        ok: true,
        released: false,
        skipped: `status_${status || 'unknown'}`,
      });
    }

    if (!isHoldExpired(row.created_at)) {
      return NextResponse.json(
        {
          error: 'hold_still_active',
          message: 'This hold has not expired yet.',
        },
        { status: 409 }
      );
    }

    const result = await releaseAbandonedHoldByCalUid(uid);
    if (!result.ok) {
      return NextResponse.json(
        { error: 'release_failed', reason: result.reason },
        { status: result.retryable ? 502 : 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/booking/release-hold] failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'release_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
