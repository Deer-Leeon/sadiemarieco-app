/**
 * GET /api/admin/manual-booking/slots
 *
 * Admin-only proxy for Cal.com v2 available slots.
 * Query: eventTypeId (number), date (YYYY-MM-DD), optional end (YYYY-MM-DD).
 * When `end` is provided and differs from `date`, returns all days in the range.
 */

import { NextRequest, NextResponse } from 'next/server';

import { syncCalEventTypeBookingPoliciesIfStale } from '@/app/admin/services/sync';
import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import {
  CAL_SLOTS_API_VERSION,
  gateAdmin,
  normalizeCalSlotsForDate,
  normalizeCalSlotsPayload,
  proxyCalV2Get,
} from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const eventTypeIdRaw = req.nextUrl.searchParams.get('eventTypeId');
  const date = req.nextUrl.searchParams.get('date')?.trim() ?? '';
  const end = req.nextUrl.searchParams.get('end')?.trim() ?? date;

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

  if (!ISO_DATE_RE.test(end)) {
    return NextResponse.json(
      { error: 'invalid_end', message: 'end must be YYYY-MM-DD' },
      { status: 400 }
    );
  }

  if (end < date) {
    return NextResponse.json(
      { error: 'invalid_range', message: 'end must be on or after date' },
      { status: 400 }
    );
  }

  // Throttled sweep so legacy Cal event-types match lib/cal-config.ts policy.
  await syncCalEventTypeBookingPoliciesIfStale();

  const result = await proxyCalV2Get(
    '/slots',
    {
      eventTypeId: String(eventTypeId),
      start: date,
      end,
      timeZone: STUDIO_TIMEZONE,
    },
    CAL_SLOTS_API_VERSION
  );

  if (!result.ok) return result.response;

  if (end === date) {
    return NextResponse.json(normalizeCalSlotsForDate(result.data, date));
  }
  return NextResponse.json(normalizeCalSlotsPayload(result.data));
}
