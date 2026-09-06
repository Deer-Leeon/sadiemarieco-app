/**
 * PATCH /api/admin/appointments/[id]/client-sms-intent
 *
 * Claims or releases `{calUid}:skip_client_sms` in webhook_events so a
 * Cal embed reschedule can finish (and fire BOOKING_RESCHEDULED) before
 * POST /reschedule without texting the client.
 *
 * Body: { skip_client_sms: boolean }
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  claimSkipClientSms,
  releaseSkipClientSms,
} from '@/lib/booking-notifications';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string }>;
}

function parseIntegerId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSkipFlag(raw: unknown): boolean | null {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return null;
}

async function findAppointmentCalUid(
  idParam: string
): Promise<{ cal_event_id: string | null } | null> {
  if (UUID_RE.test(idParam)) {
    const { rows } = await sql<{ cal_event_id: string | null }>`
      SELECT cal_event_id
      FROM appointments
      WHERE id = ${idParam}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  const intId = parseIntegerId(idParam);
  if (intId !== null) {
    const { rows } = await sql<{ cal_event_id: string | null }>`
      SELECT cal_event_id
      FROM appointments
      WHERE id = ${intId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id: idParam } = await params;
  if (!UUID_RE.test(idParam) && parseIntegerId(idParam) === null) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const skip = parseSkipFlag(
    (raw as { skip_client_sms?: unknown }).skip_client_sms
  );
  if (skip === null) {
    return NextResponse.json(
      { error: 'invalid_skip_client_sms' },
      { status: 400 }
    );
  }

  const row = await findAppointmentCalUid(idParam);
  if (row === null) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const calUid = row.cal_event_id?.trim() || null;
  if (!calUid) {
    return NextResponse.json({
      ok: true,
      skipped: 'no_cal_uid',
      skip_client_sms: skip,
    });
  }

  if (skip) {
    await claimSkipClientSms(calUid);
  } else {
    await releaseSkipClientSms(calUid);
  }

  return NextResponse.json({
    ok: true,
    skip_client_sms: skip,
    cal_uid: calUid,
  });
}
