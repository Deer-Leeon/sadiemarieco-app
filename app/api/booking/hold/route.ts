/**
 * GET /api/booking/hold?uid=<calBookingUid>
 *
 * Public read of the local checkout hold for the /checkout countdown.
 * The Cal booking UID in the URL is the same opaque token the client
 * already received from the embed redirect.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import {
  CHECKOUT_HOLD_MINUTES,
  holdDeadlineMs,
  isHoldExpired,
} from '@/lib/booking-hold';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const uid = req.nextUrl.searchParams.get('uid')?.trim() ?? '';
  if (!uid || uid.length > 200) {
    return NextResponse.json({ error: 'invalid_cal_booking_uid' }, { status: 400 });
  }

  try {
    const row = await getAppointmentHoldByCalUid(uid);
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const status = (row.status || '').toLowerCase();
    const createdAt = row.created_at;
    const expiredByTime = isHoldExpired(createdAt);
    const expiredByStatus = status === 'canceled_by_system';
    const expiresAt =
      createdAt != null
        ? new Date(holdDeadlineMs(createdAt)).toISOString()
        : null;

    return NextResponse.json({
      createdAt,
      status: row.status,
      expiresAt,
      holdMinutes: CHECKOUT_HOLD_MINUTES,
      expired: expiredByTime || expiredByStatus,
      bookingTime: row.booking_time,
      endTime: row.end_time,
      serviceName: row.service_name,
    });
  } catch (err) {
    console.error('[api/booking/hold] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
