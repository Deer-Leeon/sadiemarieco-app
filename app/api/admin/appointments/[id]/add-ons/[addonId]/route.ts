/**
 * DELETE /api/admin/appointments/[id]/add-ons/[addonId]
 *
 * Remove an unsettled extra from a visit. Settled extras must be undone
 * first (same rule as cash/comp on a regular appointment).
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import { getSucceededAppointmentPayment } from '@/lib/appointment-settlement';
import {
  getLatestTerminalPayment,
  isValidAppointmentId,
} from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string; addonId: string }>;
}

function authError(reason: string): NextResponse {
  return NextResponse.json(
    { error: reason },
    { status: reason === 'unauthenticated' ? 401 : 403 }
  );
}

export async function DELETE(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id, addonId } = await params;
  if (!isValidAppointmentId(id) || !isValidAppointmentId(addonId)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    await ensureAppointmentAttachedSchema();
    const { rows } = await sql<{
      id: string;
      attached_to_appointment_id: string | null;
    }>`
      SELECT id::text AS id,
             attached_to_appointment_id::text AS attached_to_appointment_id
      FROM appointments
      WHERE id::text = ${addonId}
      LIMIT 1
    `;
    const extra = rows[0];
    if (!extra || extra.attached_to_appointment_id !== id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const succeeded = await getSucceededAppointmentPayment(addonId);
    if (succeeded) {
      return NextResponse.json(
        {
          error: 'already_paid',
          message:
            'Undo cash or complimentary on this extra before removing it.',
          payment: succeeded,
        },
        { status: 409 }
      );
    }

    const terminal = await getLatestTerminalPayment(addonId);
    if (
      terminal &&
      (terminal.status === 'pending' || terminal.status === 'processing')
    ) {
      return NextResponse.json(
        {
          error: 'payment_in_progress',
          message:
            'A Terminal payment is already active on this extra. Cancel it before removing the extra.',
        },
        { status: 409 }
      );
    }

    await sql`
      DELETE FROM appointments
      WHERE id::text = ${addonId}
        AND attached_to_appointment_id::text = ${id}
    `;

    return NextResponse.json({ ok: true, id: addonId });
  } catch (err) {
    console.error('[add-ons DELETE] failed', err);
    return NextResponse.json(
      {
        error: 'delete_failed',
        message:
          err instanceof Error ? err.message : 'Could not remove that extra.',
      },
      { status: 500 }
    );
  }
}
