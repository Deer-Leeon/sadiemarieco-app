/**
 * POST /api/admin/time-blocks — block studio time on Cal.com + local mirror.
 * GET  /api/admin/time-blocks — list blocks (optional ?from=&to= ISO bounds).
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { gateAdmin } from '@/lib/cal-proxy';
import {
  cancelCalTimeBlockBookings,
  createCalTimeBlockBookings,
} from '@/lib/cal-time-block';
import { CalStartTimeError, parseBookingStartForCal } from '@/lib/cal-timezone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CreateBody {
  start?: unknown;
  end?: unknown;
  note?: unknown;
}

function parseIsoField(value: unknown, field: string): Date | { error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${field} is required` };
  }
  try {
    return parseBookingStartForCal(value.trim());
  } catch (err) {
    const message =
      err instanceof CalStartTimeError ? err.message : 'Invalid date/time';
    return { error: message };
  }
}

function parseCalBookingUids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (uid): uid is string => typeof uid === 'string' && uid.trim().length > 0
  );
}

function serializeBlockRow(r: {
  id: string;
  start_time: Date;
  end_time: Date;
  note: string | null;
  cal_booking_uid: string | null;
  cal_booking_uids?: unknown;
}) {
  const cal_booking_uids = parseCalBookingUids(r.cal_booking_uids);
  return {
    id: r.id,
    start_time: new Date(r.start_time).toISOString(),
    end_time: new Date(r.end_time).toISOString(),
    note: r.note,
    cal_booking_uid: r.cal_booking_uid,
    cal_booking_uids:
      cal_booking_uids.length > 0
        ? cal_booking_uids
        : r.cal_booking_uid
          ? [r.cal_booking_uid]
          : [],
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');

  try {
    if (from && to) {
      const { rows } = await sql<{
        id: string;
        start_time: Date;
        end_time: Date;
        note: string | null;
        cal_booking_uid: string | null;
        cal_booking_uids: unknown;
      }>`
        SELECT id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
        FROM studio_time_blocks
        WHERE start_time < ${to}::timestamptz
          AND end_time > ${from}::timestamptz
        ORDER BY start_time ASC
      `;
      return NextResponse.json({
        blocks: rows.map(serializeBlockRow),
      });
    }

    const { rows } = await sql<{
      id: string;
      start_time: Date;
      end_time: Date;
      note: string | null;
      cal_booking_uid: string | null;
      cal_booking_uids: unknown;
    }>`
      SELECT id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
      FROM studio_time_blocks
      WHERE end_time >= NOW() - INTERVAL '30 days'
      ORDER BY start_time ASC
      LIMIT 500
    `;
    return NextResponse.json({
      blocks: rows.map(serializeBlockRow),
    });
  } catch (err) {
    console.error('[api/admin/time-blocks] GET failed:', err);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not load time blocks' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const body = (rawBody ?? {}) as CreateBody;
  const startParsed = parseIsoField(body.start, 'start');
  if ('error' in startParsed) {
    return NextResponse.json(
      { error: 'invalid_start', message: startParsed.error },
      { status: 400 }
    );
  }
  const endParsed = parseIsoField(body.end, 'end');
  if ('error' in endParsed) {
    return NextResponse.json(
      { error: 'invalid_end', message: endParsed.error },
      { status: 400 }
    );
  }

  const start = startParsed;
  const end = endParsed;
  if (end <= start) {
    return NextResponse.json(
      { error: 'invalid_range', message: 'End time must be after start time' },
      { status: 400 }
    );
  }

  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (durationMinutes < 30) {
    return NextResponse.json(
      {
        error: 'invalid_range',
        message: 'Blocks must be at least 30 minutes for Cal.com.',
      },
      { status: 400 }
    );
  }

  const note =
    typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null;

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  try {
    const { rows: aptRows } = await sql<{
      id: string;
      booking_time: Date;
      end_time: Date | null;
      status: string | null;
    }>`
      SELECT id, booking_time, end_time, status
      FROM appointments
      WHERE booking_time IS NOT NULL
        AND booking_time < ${endIso}::timestamptz
        AND COALESCE(
          end_time,
          booking_time + INTERVAL '60 minutes'
        ) > ${startIso}::timestamptz
        AND COALESCE(status, '') NOT IN (
          'canceled_by_admin',
          'canceled_by_client',
          'canceled_by_client_late',
          'canceled_by_system'
        )
      LIMIT 1
    `;

    if (aptRows.length > 0) {
      return NextResponse.json(
        {
          error: 'overlap',
          message: 'This interval overlaps an existing appointment',
        },
        { status: 409 }
      );
    }

    const { rows: blockRows } = await sql<{
      id: string;
      start_time: Date;
      end_time: Date;
    }>`
      SELECT id, start_time, end_time
      FROM studio_time_blocks
      WHERE start_time < ${endIso}::timestamptz
        AND end_time > ${startIso}::timestamptz
      LIMIT 1
    `;

    if (blockRows.length > 0) {
      return NextResponse.json(
        {
          error: 'overlap',
          message: 'This interval overlaps an existing time block',
        },
        { status: 409 }
      );
    }
  } catch (err) {
    console.error('[api/admin/time-blocks] overlap check failed:', err);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not validate the requested interval' },
      { status: 500 }
    );
  }

  const calResult = await createCalTimeBlockBookings({
    startIso,
    durationMinutes,
  });

  if (!calResult.ok) {
    return NextResponse.json(
      { error: 'cal_error', message: calResult.error },
      { status: 502 }
    );
  }

  const calEndIso = new Date(
    start.getTime() + calResult.calTotalMinutes * 60_000
  ).toISOString();
  const calUidsJson = JSON.stringify(calResult.uids);

  try {
    const { rows } = await sql<{
      id: string;
      start_time: Date;
      end_time: Date;
      note: string | null;
      cal_booking_uid: string | null;
      cal_booking_uids: unknown;
    }>`
      INSERT INTO studio_time_blocks (
        start_time, end_time, note, cal_booking_uid, cal_booking_uids
      )
      VALUES (
        ${startIso}::timestamptz,
        ${calEndIso}::timestamptz,
        ${note},
        ${calResult.uids[0] ?? null},
        ${calUidsJson}::jsonb
      )
      RETURNING id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
    `;

    const row = rows[0];
    return NextResponse.json({
      block: serializeBlockRow(row),
      ...(calResult.roundedUpMinutes > 0
        ? {
            rounded_up_minutes: calResult.roundedUpMinutes,
            message: `Extended by ${calResult.roundedUpMinutes} minute${
              calResult.roundedUpMinutes === 1 ? '' : 's'
            } so Cal.com can hold the full block.`,
          }
        : {}),
    });
  } catch (err) {
    console.error('[api/admin/time-blocks] insert failed — rolling back Cal bookings', {
      uids: calResult.uids,
      err,
    });
    await cancelCalTimeBlockBookings(calResult.uids).catch(() => undefined);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not save the time block' },
      { status: 500 }
    );
  }
}
