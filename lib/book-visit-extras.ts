import 'server-only';

import { sql } from '@vercel/postgres';

import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import type { BookableService } from '@/lib/book-public';
import { endIsoFromDuration } from '@/lib/chair-duration';
import { ensureChairDurationSchema } from '@/lib/visit-duration';

/**
 * After the primary Cal hold exists: one chair block for every selected service,
 * with the combined price on the parent and one attached row per extra.
 */
export async function applyPublicBookingExtras(args: {
  calUid: string;
  durationMins: number;
  priceCents: number;
  extras: BookableService[];
}): Promise<void> {
  if (args.extras.length === 0) return;
  await ensureChairDurationSchema();
  await ensureAppointmentAttachedSchema();

  const { rows } = await sql<{
    id: string;
    booking_time: Date | string | null;
    client_id: string | null;
    client_first_name: string | null;
    client_last_name: string | null;
    client_email: string | null;
    client_phone: string | null;
    sms_opt_in: boolean | null;
    stripe_customer_id: string | null;
  }>`
    SELECT
      id::text AS id,
      booking_time,
      client_id::text AS client_id,
      client_first_name,
      client_last_name,
      client_email,
      client_phone,
      sms_opt_in,
      stripe_customer_id
    FROM appointments
    WHERE cal_event_id = ${args.calUid}
      AND attached_to_appointment_id IS NULL
    LIMIT 1
  `;
  const parent = rows[0];
  if (!parent?.booking_time) {
    throw new Error('primary visit was not saved');
  }
  const startIso =
    parent.booking_time instanceof Date
      ? parent.booking_time.toISOString()
      : new Date(parent.booking_time).toISOString();
  const endIso = endIsoFromDuration(startIso, args.durationMins);
  if (!endIso) throw new Error('could not compute the combined end time');

  await sql`
    UPDATE appointments
    SET chair_duration_mins = ${args.durationMins},
        end_time = ${endIso},
        quoted_service_price_cents = ${args.priceCents}
    WHERE id::text = ${parent.id}
  `;

  for (const extra of args.extras) {
    await sql`
      INSERT INTO appointments (
        client_id,
        service_name,
        booking_time,
        end_time,
        cal_event_id,
        cal_event_type_id,
        quoted_service_price_cents,
        client_first_name,
        client_last_name,
        client_email,
        client_phone,
        status,
        sms_opt_in,
        stripe_customer_id,
        attached_to_appointment_id
      )
      VALUES (
        ${parent.client_id}::uuid,
        ${extra.title},
        ${startIso},
        ${endIso},
        NULL,
        ${extra.calEventId},
        ${extra.priceCents},
        ${parent.client_first_name},
        ${parent.client_last_name},
        ${parent.client_email},
        ${parent.client_phone},
        'pending',
        ${parent.sms_opt_in},
        ${parent.stripe_customer_id},
        ${parent.id}::uuid
      )
    `;
  }
}
