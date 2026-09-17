/**
 * PATCH /api/admin/appointments/[id]/duration
 *
 * Set the total chair length for a confirmed visit. Overlapping the
 * next booking is allowed (admin). Public occupancy follows end_time.
 */
import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { loadVisitAppointment } from '@/lib/admin-appointment-load';
import {
  CHAIR_DURATION_MAX_MIN,
  CHAIR_DURATION_MIN_MIN,
} from '@/lib/chair-duration';
import { isValidAppointmentId } from '@/lib/stripe-terminal';
import { applyChairDuration } from '@/lib/visit-duration';

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

function codeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code ?? '');
  }
  return '';
}

export async function PATCH(
  req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { durationMins?: unknown } = {};
  try {
    body = (await req.json()) as { durationMins?: unknown };
  } catch {
    body = {};
  }

  const raw =
    typeof body.durationMins === 'number'
      ? body.durationMins
      : typeof body.durationMins === 'string'
        ? Number(body.durationMins)
        : NaN;
  if (!Number.isFinite(raw)) {
    return NextResponse.json(
      {
        error: 'invalid_duration',
        message: `durationMins must be a number between ${CHAIR_DURATION_MIN_MIN} and ${CHAIR_DURATION_MAX_MIN}.`,
      },
      { status: 400 }
    );
  }

  try {
    await applyChairDuration({ parentId: id, durationMins: raw });
    const appointment = await loadVisitAppointment(id);
    if (!appointment) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ appointment });
  } catch (err) {
    const code = codeOf(err);
    if (code === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (code === 'not_a_visit') {
      return NextResponse.json(
        {
          error: 'not_a_visit',
          message: 'Visit length can only be set on a booked visit, not an extra.',
        },
        { status: 409 }
      );
    }
    if (code === 'parent_not_attachable') {
      return NextResponse.json(
        {
          error: 'parent_not_attachable',
          message: 'Visit length can only be changed on a confirmed visit.',
        },
        { status: 409 }
      );
    }
    console.error('[appointments duration PATCH] failed', err);
    return NextResponse.json(
      {
        error: 'duration_update_failed',
        message:
          err instanceof Error ? err.message : 'Could not update visit length.',
      },
      { status: 500 }
    );
  }
}
