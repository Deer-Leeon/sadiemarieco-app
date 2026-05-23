/**
 * POST /api/admin/appointments/[id]/reschedule
 *
 * Applies an admin-initiated reschedule to the local `appointments`
 * row. Called by `AppointmentModal` immediately after Cal.com fires
 * its `rescheduleBookingSuccessful(V2)` event so the dashboard's
 * view reflects the new slot the instant the modal closes —
 * independent of when Cal's BOOKING_RESCHEDULED webhook hits our
 * server.
 *
 * Body: { newCalUid, newBookingTime, newEndTime?, oldCalUid? }
 *   • newCalUid       — UID Cal stamped on the rescheduled booking
 *   • newBookingTime  — ISO 8601 start of the new slot
 *   • newEndTime      — ISO 8601 end (optional)
 *   • oldCalUid       — fallback lookup key when the URL `[id]` is
 *                       malformed; matches appointments.cal_event_id
 *
 * Row lookup order:
 *   1. appointments.id = URL param when it's a UUID
 *   2. appointments.id = URL param when it's a legacy integer
 *   3. appointments.cal_event_id = body.oldCalUid
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ id: string }>;
}

interface RescheduleBody {
  newCalUid?: unknown;
  newBookingTime?: unknown;
  newEndTime?: unknown;
  oldCalUid?: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseIntegerId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return trimmed;
}

function sanitiseCalUid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (/[\s/\\]/.test(trimmed)) return null;
  return trimmed;
}

interface UpdatedRow {
  id: string | number;
  cal_event_id: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  status: string | null;
}

function serialiseDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function POST(
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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const body = raw as RescheduleBody;
  const newCalUid = sanitiseCalUid(body.newCalUid);
  const newBookingTime = parseIsoTimestamp(body.newBookingTime);
  const oldCalUid = sanitiseCalUid(body.oldCalUid);

  const newEndTimeRaw = body.newEndTime;
  let newEndTime: string | null = null;
  if (newEndTimeRaw !== undefined && newEndTimeRaw !== null) {
    newEndTime = parseIsoTimestamp(newEndTimeRaw);
    if (newEndTime === null) {
      return NextResponse.json(
        { error: 'invalid_end_time' },
        { status: 400 }
      );
    }
  }

  if (!newCalUid || !newBookingTime) {
    return NextResponse.json(
      {
        error: 'missing_fields',
        hint: 'newCalUid and newBookingTime are required',
      },
      { status: 400 }
    );
  }

  const intId = parseIntegerId(idParam);
  const isUuid = UUID_RE.test(idParam);
  if (!isUuid && intId === null && !oldCalUid) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    let rows: UpdatedRow[] = [];

    if (isUuid) {
      ({ rows } = await sql<UpdatedRow>`
        UPDATE appointments
        SET cal_event_id = ${newCalUid},
            booking_time = ${newBookingTime},
            end_time     = ${newEndTime},
            status       = 'confirmed'
        WHERE id = ${idParam}::uuid
        RETURNING id, cal_event_id, booking_time, end_time, status
      `);
    } else if (intId !== null) {
      ({ rows } = await sql<UpdatedRow>`
        UPDATE appointments
        SET cal_event_id = ${newCalUid},
            booking_time = ${newBookingTime},
            end_time     = ${newEndTime},
            status       = 'confirmed'
        WHERE id = ${intId}
        RETURNING id, cal_event_id, booking_time, end_time, status
      `);
    }

    // Fallback: URL id didn't match — locate by the Cal UID we had
    // before the reschedule (handles stale route params / copy-paste
    // bugs without leaving the calendar out of sync).
    if (rows.length === 0 && oldCalUid) {
      ({ rows } = await sql<UpdatedRow>`
        UPDATE appointments
        SET cal_event_id = ${newCalUid},
            booking_time = ${newBookingTime},
            end_time     = ${newEndTime},
            status       = 'confirmed'
        WHERE cal_event_id = ${oldCalUid}
        RETURNING id, cal_event_id, booking_time, end_time, status
      `);
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const row = rows[0];
    return NextResponse.json({
      appointment: {
        id: row.id,
        cal_uid: row.cal_event_id,
        booking_time: serialiseDate(row.booking_time),
        end_time: serialiseDate(row.end_time),
        status: row.status,
      },
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes('appointments_cal_event_id_key')) {
      return NextResponse.json(
        {
          error: 'cal_uid_conflict',
          message:
            'Another local appointment already references this Cal.com UID.',
        },
        { status: 409 }
      );
    }
    console.error(
      '[api/admin/appointments/[id]/reschedule] update failed:',
      msg
    );
    return NextResponse.json(
      { error: 'db_update_failed', message: msg },
      { status: 500 }
    );
  }
}
