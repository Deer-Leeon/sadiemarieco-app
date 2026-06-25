/**
 * DELETE /api/admin/time-blocks/[id] — remove a block locally + on Cal.com.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { gateAdmin } from '@/lib/cal-proxy';
import {
  cancelCalTimeBlockBookings,
} from '@/lib/cal-time-block';
import { allCalBookingUids } from '@/lib/cal-time-block-segments';
import { isIngestedTimeBlockAppointment } from '@/app/admin/time-block-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string }>;
}

function parseCalBookingUids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (uid): uid is string => typeof uid === 'string' && uid.trim().length > 0
  );
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
      console.error('[api/admin/time-blocks] ghost appointment cleanup failed:', err);
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
