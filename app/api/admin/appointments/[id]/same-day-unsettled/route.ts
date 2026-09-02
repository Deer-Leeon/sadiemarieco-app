import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { findSameDayUnsettledSiblings } from '@/lib/same-day-unsettled';
import { isValidAppointmentId } from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string }>;
}

function authError(reason: string): NextResponse {
  return NextResponse.json(
    { error: reason },
    { status: reason === 'unauthenticated' ? 401 : 403 }
  );
}

export async function GET(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    const visits = await findSameDayUnsettledSiblings(id);
    return NextResponse.json({
      appointments: visits.map((visit) => ({
        id: visit.id,
        booking_time: visit.booking_time,
        end_time: visit.end_time,
        service_name: visit.service_name,
        quoted_service_price_cents: visit.quoted_service_price_cents,
        service_price:
          visit.quoted_service_price_cents == null
            ? null
            : Number(visit.quoted_service_price_cents) / 100,
      })),
    });
  } catch (err) {
    console.error('[same-day-unsettled] failed', err);
    return NextResponse.json(
      {
        error: 'lookup_failed',
        message:
          err instanceof Error
            ? err.message
            : 'Could not load other appointments for this client.',
      },
      { status: 500 }
    );
  }
}
