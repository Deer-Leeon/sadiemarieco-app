import { sql } from '@vercel/postgres';

export interface AppointmentHoldRow {
  created_at: string | null;
  status: string | null;
  booking_time: string | null;
  end_time: string | null;
  service_name: string | null;
}

function serializeTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Lookup the local hold row for a Cal booking UID (`appointments.cal_event_id`). */
export async function getAppointmentHoldByCalUid(
  calBookingUid: string
): Promise<AppointmentHoldRow | null> {
  const { rows } = await sql<{
    created_at: Date | string | null;
    status: string | null;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    service_name: string | null;
  }>`
    SELECT created_at, status, booking_time, end_time, service_name
    FROM appointments
    WHERE cal_event_id = ${calBookingUid}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    created_at: serializeTimestamp(rows[0].created_at),
    status: rows[0].status,
    booking_time: serializeTimestamp(rows[0].booking_time),
    end_time: serializeTimestamp(rows[0].end_time),
    service_name: rows[0].service_name,
  };
}
