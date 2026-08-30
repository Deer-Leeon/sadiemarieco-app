/**
 * GET /api/book/slots
 *
 * Public availability for a service slug (studio timezone).
 * Query: slug, date (YYYY-MM-DD), optional end (YYYY-MM-DD).
 *
 * Starts come from Cal working hours (weekly + date overrides) minus
 * live Postgres occupancy. Cal.com /slots is not used: cancelled Cal
 * bookings often leave connected-calendar busy events that would hide
 * times the studio calendar shows as open.
 */

import { NextRequest, NextResponse } from 'next/server';

import { loadBookableServiceBySlug } from '@/lib/book-public';
import { listStudioAvailableSlots } from '@/lib/studio-available-slots';
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

  const listed = await listStudioAvailableSlots({
    rangeStartYmd: date,
    rangeEndYmd: end,
    durationMins: service.durationMins,
  });
  if (!listed.ok) {
    return NextResponse.json(
      { error: 'slots_unavailable', message: listed.message },
      { status: 502 }
    );
  }

  if (end === date) {
    return NextResponse.json({
      slug: service.slug,
      slots: { [date]: listed.slots[date] ?? [] },
    });
  }

  return NextResponse.json({
    slug: service.slug,
    slots: listed.slots,
  });
}
