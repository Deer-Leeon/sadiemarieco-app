import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  getSucceededAppointmentPayment,
  isManualSettlementKind,
  undoManualSettlement,
} from '@/lib/appointment-settlement';
import { isValidAppointmentId } from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string }>;
}

export async function POST(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    const succeeded = await getSucceededAppointmentPayment(id);
    if (!succeeded) {
      return NextResponse.json(
        {
          error: 'not_settled',
          message: 'This appointment has no settled payment to undo.',
        },
        { status: 409 }
      );
    }
    if (!isManualSettlementKind(succeeded.payment_kind)) {
      return NextResponse.json(
        {
          error: 'undo_not_allowed',
          message:
            'Card payments collected on the Terminal cannot be undone here. Refund them in Stripe if needed.',
          payment: succeeded,
        },
        { status: 409 }
      );
    }

    const payment = await undoManualSettlement(id);
    if (!payment) {
      return NextResponse.json(
        {
          error: 'undo_failed',
          message: 'Could not undo this settlement.',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ payment });
  } catch (err) {
    console.error('[settlement] undo failed', err);
    return NextResponse.json(
      {
        error: 'undo_failed',
        message: err instanceof Error ? err.message : 'Undo failed.',
      },
      { status: 500 }
    );
  }
}
