import { sql } from '@vercel/postgres';

export interface AppointmentHoldRow {
  created_at: string | null;
  status: string | null;
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
  const { rows } = await sql<{ created_at: Date | string | null; status: string | null }>`
    SELECT created_at, status
    FROM appointments
    WHERE cal_event_id = ${calBookingUid}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    created_at: serializeTimestamp(rows[0].created_at),
    status: rows[0].status,
  };
}
