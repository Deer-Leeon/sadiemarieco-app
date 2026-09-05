import 'server-only';

import { sql } from '@vercel/postgres';

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function syncAttachedExtrasTimes(
  parentId: string,
  bookingTime: string | Date | null,
  endTime: string | Date | null
): Promise<void> {
  if (!parentId) return;
  const startIso = toIsoTimestamp(bookingTime);
  const endIso = toIsoTimestamp(endTime);
  await sql`
    UPDATE appointments
    SET booking_time = ${startIso},
        end_time = ${endIso}
    WHERE attached_to_appointment_id::text = ${parentId}
  `;
}

/**
 * Drop extras that were never settled when the parent visit is canceled.
 * Paid extras stay nested on the canceled visit for history.
 */
export async function deleteUnsettledAttachedExtras(
  parentId: string
): Promise<void> {
  if (!parentId) return;
  await sql`
    DELETE FROM appointments extra
    WHERE extra.attached_to_appointment_id::text = ${parentId}
      AND NOT EXISTS (
        SELECT 1
        FROM appointment_payments p
        WHERE p.appointment_id = extra.id::text
          AND p.status = 'succeeded'
      )
  `;
}
