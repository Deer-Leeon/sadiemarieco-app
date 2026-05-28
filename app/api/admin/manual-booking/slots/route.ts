/**
 * GET /api/admin/manual-booking/slots
 *
 * Admin-only proxy for Cal.com v1 available slots.
 * Query: eventTypeId (number), date (YYYY-MM-DD).
 */

import { NextRequest, NextResponse } from 'next/server';

import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { gateAdmin, proxyCalV1Get } from '@/lib/cal-v1-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const eventTypeIdRaw = req.nextUrl.searchParams.get('eventTypeId');
  const date = req.nextUrl.searchParams.get('date')?.trim() ?? '';

  const eventTypeId = eventTypeIdRaw ? Number(eventTypeIdRaw) : NaN;
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return NextResponse.json(
      { error: 'invalid_event_type_id', message: 'eventTypeId must be a positive integer' },
      { status: 400 }
    );
  }

  if (!ISO_DATE_RE.test(date)) {
    return NextResponse.json(
      { error: 'invalid_date', message: 'date must be YYYY-MM-DD' },
      { status: 400 }
    );
  }

  const result = await proxyCalV1Get('/slots', {
    eventTypeId: String(eventTypeId),
    startTime: date,
    endTime: date,
    timeZone: STUDIO_TIMEZONE,
  });

  if (!result.ok) return result.response;
  return NextResponse.json(result.data);
}
