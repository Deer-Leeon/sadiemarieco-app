import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  getSucceededAppointmentPayment,
  insertManualSettlement,
  isSettlementUniqueConflict,
} from '@/lib/appointment-settlement';
import {
  findTerminalAppointment,
  getLatestTerminalPayment,
  isValidAppointmentId,
} from '@/lib/stripe-terminal';

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

export async function POST(
  req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { method?: unknown; note?: unknown } = {};
  try {
    body = (await req.json()) as { method?: unknown; note?: unknown };
  } catch {
    body = {};
  }

  const method = body.method;
  if (method !== 'cash' && method !== 'complimentary') {
    return NextResponse.json(
      {
        error: 'invalid_method',
        message: 'Settlement method must be cash or complimentary.',
      },
      { status: 400 }
    );
  }

  const noteRaw = typeof body.note === 'string' ? body.note.trim() : '';
  const note = noteRaw.length > 0 ? noteRaw.slice(0, 500) : null;
  const settledByEmail = access.emails[0] || 'admin';

  try {
    const appointment = await findTerminalAppointment(id);
    if (!appointment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if ((appointment.status || '').toLowerCase() !== 'confirmed') {
      return NextResponse.json(
        {
          error: 'appointment_not_settleable',
          message: 'Only confirmed appointments can be marked settled.',
        },
        { status: 409 }
      );
    }

    const succeeded = await getSucceededAppointmentPayment(appointment.id);
    if (succeeded) {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This appointment is already settled.',
          payment: succeeded,
        },
        { status: 409 }
      );
    }

    const terminal = await getLatestTerminalPayment(appointment.id);
    if (
      terminal &&
      (terminal.status === 'pending' || terminal.status === 'processing')
    ) {
      return NextResponse.json(
        {
          error: 'payment_in_progress',
          message:
            'A Terminal payment is already active. Cancel it before marking cash or complimentary.',
          payment: terminal,
        },
        { status: 409 }
      );
    }

    const amountCents = Number(appointment.quoted_service_price_cents);
    if (method === 'cash') {
      if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
        return NextResponse.json(
          {
            error: 'service_price_unavailable',
            message:
              'This appointment does not have a valid quoted service price for cash settlement.',
          },
          { status: 409 }
        );
      }
    }

    const payment = await insertManualSettlement({
      appointmentId: appointment.id,
      calBookingUid: appointment.cal_booking_uid,
      kind: method,
      baseAmountCents: method === 'complimentary' ? 0 : amountCents,
      note,
      settledByEmail,
    });

    return NextResponse.json({ payment });
  } catch (err) {
    if (isSettlementUniqueConflict(err)) {
      const payment = await getSucceededAppointmentPayment(id);
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This appointment is already settled.',
          payment,
        },
        { status: 409 }
      );
    }
    console.error('[settlement] mark failed', err);
    return NextResponse.json(
      {
        error: 'settlement_failed',
        message: err instanceof Error ? err.message : 'Settlement failed.',
      },
      { status: 500 }
    );
  }
}
