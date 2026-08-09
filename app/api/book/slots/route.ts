/**
 * GET /api/book/slots
 *
 * Public Cal.com availability for a service slug (studio timezone).
 * Query: slug, date (YYYY-MM-DD), optional end (YYYY-MM-DD).
 */

import { NextRequest, NextResponse } from 'next/server';

import { loadBookableServiceBySlug } from '@/lib/book-public';
import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { addCalendarDays } from '@/lib/cal-slot-dates';
import {
  CAL_SLOTS_API_VERSION,
  normalizeCalSlotsPayload,
  proxyCalV2Get,
} from '@/lib/cal-proxy';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `book-slots:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookSlots,
  });
  if (limited) return limited;

  const slug = req.nextUrl.searchParams.get('slug')?.trim() ?? '';
  const date = req.nextUrl.searchParams.get('date')?.trim() ?? '';
  const end = req.nextUrl.searchParams.get('end')?.trim() ?? date;

  if (!slug) {
    return NextResponse.json(
      { error: 'invalid_slug', message: 'slug is required' },
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

  const service = await loadBookableServiceBySlug(slug);
  if (!service) {
    return NextResponse.json(
      { error: 'service_not_found', message: 'That service is not available.' },
      { status: 404 }
    );
  }

  const calRangeEnd = addCalendarDays(end, 1);
  const slotQuery: Record<string, string> = {
    eventTypeId: String(service.calEventId),
    start: date,
    end: calRangeEnd,
    timeZone: STUDIO_TIMEZONE,
    duration: String(service.durationMins),
  };

  const result = await proxyCalV2Get('/slots', slotQuery, CAL_SLOTS_API_VERSION);
  if (!result.ok) return result.response;

  const normOpts = { studioDateStart: date, studioDateEnd: end };
  if (end === date) {
    const normalized = normalizeCalSlotsPayload(result.data, normOpts);
    return NextResponse.json({
      slug: service.slug,
      slots: { [date]: normalized.slots[date] ?? [] },
    });
  }

  return NextResponse.json({
    slug: service.slug,
    ...normalizeCalSlotsPayload(result.data, normOpts),
  });
}
