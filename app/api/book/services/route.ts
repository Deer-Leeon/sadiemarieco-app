/**
 * GET /api/book/services
 *
 * Public catalogue for the phone guided booker.
 */

import { NextRequest, NextResponse } from 'next/server';

import { loadBookableServices } from '@/lib/book-public';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `book-services:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookServices,
  });
  if (limited) return limited;

  try {
    const services = await loadBookableServices();
    return NextResponse.json({
      services: services.map(
        ({
          slug,
          title,
          category,
          description,
          priceLabel,
          durationMins,
          durationLabel,
        }) => ({
          slug,
          title,
          category,
          description,
          priceLabel,
          durationMins,
          durationLabel,
        })
      ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/book/services] failed:', message);
    return NextResponse.json(
      { error: 'services_load_failed', message },
      { status: 500 }
    );
  }
}
