/**
 * PATCH  /api/admin/time-blocks/[id] — update note and/or time window.
 * DELETE /api/admin/time-blocks/[id] — remove a block locally + on Cal.com.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { gateAdmin } from '@/lib/cal-proxy';
import {
  cancelCalTimeBlockBookings,
  createCalTimeBlockBookings,
} from '@/lib/cal-time-block';
import { allCalBookingUids } from '@/lib/cal-time-block-segments';
import { CalStartTimeError, parseBookingStartForCal } from '@/lib/cal-timezone';
import { isIngestedTimeBlockAppointment } from '@/app/admin/time-block-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  start?: unknown;
  end?: unknown;
  note?: unknown;
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

export async function PATCH(
  req: NextRequest,
  context: Context
): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: 'invalid_id', message: 'Block id must be a UUID' },
      { status: 400 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const body = (rawBody ?? {}) as PatchBody;
  const hasStart = body.start !== undefined;
  const hasEnd = body.end !== undefined;
  const hasNote = body.note !== undefined;

  if (!hasStart && !hasEnd && !hasNote) {
    return NextResponse.json(
      {
        error: 'empty_patch',
        message: 'Provide start, end, and/or note to update',
      },
      { status: 400 }
    );
  }

  if (hasStart !== hasEnd) {
    return NextResponse.json(
      {
        error: 'invalid_range',
        message:
          'Start and end must both be provided when changing the time window',
      },
      { status: 400 }
    );
  }

  let existing: {
    id: string;
    start_time: Date;
    end_time: Date;
    note: string | null;
    cal_booking_uid: string | null;
    cal_booking_uids: unknown;
  } | null = null;

  try {
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
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    existing = rows[0] ?? null;
  } catch (err) {
    console.error('[api/admin/time-blocks] PATCH load failed:', err);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not load the time block' },
      { status: 500 }
    );
  }

  if (!existing) {
    return NextResponse.json(
      {
        error: 'not_found',
        message:
          'This block can’t be edited here. Remove it and create a new one, or refresh and try again.',
      },
      { status: 404 }
    );
  }

  const nextNote = hasNote
    ? typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null
    : existing.note;

  if (!hasStart) {
    try {
      const { rows } = await sql<{
        id: string;
        start_time: Date;
        end_time: Date;
        note: string | null;
        cal_booking_uid: string | null;
        cal_booking_uids: unknown;
      }>`
        UPDATE studio_time_blocks
        SET note = ${nextNote}
        WHERE id = ${id}::uuid
        RETURNING id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
      `;
      return NextResponse.json({ block: serializeBlockRow(rows[0]) });
    } catch (err) {
      console.error('[api/admin/time-blocks] PATCH note failed:', err);
      return NextResponse.json(
        { error: 'db_error', message: 'Could not update the time block note' },
        { status: 500 }
      );
    }
  }

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

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const sameWindow =
    Math.abs(new Date(existing.start_time).getTime() - start.getTime()) <
      1000 &&
    Math.abs(new Date(existing.end_time).getTime() - end.getTime()) < 1000;

  if (sameWindow) {
    try {
      const { rows } = await sql<{
        id: string;
        start_time: Date;
        end_time: Date;
        note: string | null;
        cal_booking_uid: string | null;
        cal_booking_uids: unknown;
      }>`
        UPDATE studio_time_blocks
        SET note = ${nextNote}
        WHERE id = ${id}::uuid
        RETURNING id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
      `;
      return NextResponse.json({ block: serializeBlockRow(rows[0]) });
    } catch (err) {
      console.error('[api/admin/time-blocks] PATCH same-window failed:', err);
      return NextResponse.json(
        { error: 'db_error', message: 'Could not update the time block' },
        { status: 500 }
      );
    }
  }

  const oldUids = allCalBookingUids({
    cal_booking_uid: existing.cal_booking_uid,
    cal_booking_uids: parseCalBookingUids(existing.cal_booking_uids),
  });

  try {
    const { rows: aptRows } = await sql<{
      id: string;
      cal_event_id: string | null;
      client_first_name: string | null;
      client_last_name: string | null;
      service_name: string | null;
    }>`
      SELECT id, cal_event_id, client_first_name, client_last_name, service_name
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
      LIMIT 20
    `;

    const conflictingApt = aptRows.find((apt) => {
      if (apt.cal_event_id && oldUids.includes(apt.cal_event_id)) {
        return false;
      }
      return !isIngestedTimeBlockAppointment(
        {
          id: apt.id,
          cal_uid: apt.cal_event_id,
          client_first_name: apt.client_first_name,
          client_last_name: apt.client_last_name,
          service_name: apt.service_name,
          booking_time: null,
          end_time: null,
          status: null,
          client_phone: null,
          client_email: null,
          booking_notes: null,
          service_price: null,
          service_description: null,
          service_slug: null,
          service_color: null,
          stripe_customer_id: null,
          terminal_payment: null,
          client_no_show_flag: false,
        },
        new Set(oldUids)
      );
    });

    if (conflictingApt) {
      return NextResponse.json(
        {
          error: 'overlap',
          message: 'This interval overlaps an existing appointment',
        },
        { status: 409 }
      );
    }

    const { rows: blockRows } = await sql<{ id: string }>`
      SELECT id
      FROM studio_time_blocks
      WHERE id <> ${id}::uuid
        AND start_time < ${endIso}::timestamptz
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
    console.error('[api/admin/time-blocks] PATCH overlap check failed:', err);
    return NextResponse.json(
      {
        error: 'db_error',
        message: 'Could not validate the requested interval',
      },
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
      UPDATE studio_time_blocks
      SET start_time = ${startIso}::timestamptz,
          end_time = ${calEndIso}::timestamptz,
          note = ${nextNote},
          cal_booking_uid = ${calResult.uids[0] ?? null},
          cal_booking_uids = ${calUidsJson}::jsonb
      WHERE id = ${id}::uuid
      RETURNING id, start_time, end_time, note, cal_booking_uid, cal_booking_uids
    `;

    if (oldUids.length > 0) {
      const calError = await cancelCalTimeBlockBookings(oldUids);
      if (calError) {
        console.warn(
          '[api/admin/time-blocks] PATCH Cal cancel of old segments failed',
          { id, oldUids, calError }
        );
      }
      try {
        for (const uid of oldUids) {
          await sql`
            UPDATE appointments
            SET status = 'canceled_by_admin'
            WHERE cal_event_id = ${uid}
              AND COALESCE(status, '') NOT IN (
                'canceled_by_admin',
                'canceled_by_client',
                'canceled_by_client_late',
                'canceled_by_system'
              )
          `;
        }
      } catch (err) {
        console.warn(
          '[api/admin/time-blocks] PATCH old appointment cleanup failed',
          {
            id,
            oldUids,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }

    return NextResponse.json({
      block: serializeBlockRow(rows[0]),
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
    console.error(
      '[api/admin/time-blocks] PATCH update failed — rolling back new Cal bookings',
      { uids: calResult.uids, err }
    );
    await cancelCalTimeBlockBookings(calResult.uids).catch(() => undefined);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not update the time block' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  context: Context
): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: 'invalid_id', message: 'Block id must be a UUID' },
      { status: 400 }
    );
  }

  let calBookingUids: string[] = [];
  let ghostAppointmentId: string | null = null;

  try {
    const { rows } = await sql<{
      cal_booking_uid: string | null;
      cal_booking_uids: unknown;
    }>`
      SELECT cal_booking_uid, cal_booking_uids
      FROM studio_time_blocks
      WHERE id = ${id}::uuid
      LIMIT 1
    `;

    if (rows.length > 0) {
      calBookingUids = allCalBookingUids({
        cal_booking_uid: rows[0].cal_booking_uid,
        cal_booking_uids: parseCalBookingUids(rows[0].cal_booking_uids),
      });
      await sql`DELETE FROM studio_time_blocks WHERE id = ${id}::uuid`;
    } else {
      const { rows: aptRows } = await sql<{
        id: string;
        cal_event_id: string | null;
        client_first_name: string | null;
        client_last_name: string | null;
        service_name: string | null;
      }>`
        SELECT id, cal_event_id, client_first_name, client_last_name, service_name
        FROM appointments
        WHERE id = ${id}::uuid
        LIMIT 1
      `;
      const apt = aptRows[0];
      if (
        !apt ||
        !isIngestedTimeBlockAppointment(
          {
            id: apt.id,
            cal_uid: apt.cal_event_id,
            client_first_name: apt.client_first_name,
            client_last_name: apt.client_last_name,
            service_name: apt.service_name,
            booking_time: null,
            end_time: null,
            status: null,
            client_phone: null,
            client_email: null,
            booking_notes: null,
            service_price: null,
            service_description: null,
            service_slug: null,
            service_color: null,
            stripe_customer_id: null,
            terminal_payment: null,
            client_no_show_flag: false,
          },
          new Set<string>()
        )
      ) {
        return NextResponse.json(
          { error: 'not_found', message: 'Time block not found' },
          { status: 404 }
        );
      }
      calBookingUids = apt.cal_event_id ? [apt.cal_event_id] : [];
      ghostAppointmentId = apt.id;
    }
  } catch (err) {
    console.error('[api/admin/time-blocks] DELETE db failed:', err);
    return NextResponse.json(
      { error: 'db_error', message: 'Could not delete the time block' },
      { status: 500 }
    );
  }

  if (calBookingUids.length > 0) {
    try {
      for (const uid of calBookingUids) {
        await sql`
          UPDATE appointments
          SET status = 'canceled_by_admin'
          WHERE cal_event_id = ${uid}
            AND COALESCE(status, '') NOT IN (
              'canceled_by_admin',
              'canceled_by_client',
              'canceled_by_client_late',
              'canceled_by_system'
            )
        `;
      }
    } catch (err) {
      console.warn('[api/admin/time-blocks] linked appointment cleanup failed', {
        id,
        calBookingUids,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (ghostAppointmentId) {
    try {
      await sql`
        UPDATE appointments
        SET status = 'canceled_by_admin'
        WHERE id = ${ghostAppointmentId}::uuid
      `;
    } catch (err) {
      console.error(
        '[api/admin/time-blocks] ghost appointment cleanup failed:',
        err
      );
    }
  }

  if (calBookingUids.length > 0) {
    const calError = await cancelCalTimeBlockBookings(calBookingUids);
    if (calError) {
      console.warn('[api/admin/time-blocks] Cal cancel failed after DB delete', {
        id,
        calBookingUids,
        calError,
      });
      return NextResponse.json({
        ok: true,
        cal_cancel_error: calError,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
