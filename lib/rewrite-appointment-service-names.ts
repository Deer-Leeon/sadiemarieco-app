import { sql } from '@vercel/postgres';

/**
 * After a catalogue / Cal title change, rewrite stored appointment
 * names that still hold the old Cal snapshot so the admin calendar,
 * reminders, and SMS labels follow the new name.
 */
export async function rewriteAppointmentServiceNames(args: {
  calEventTypeId: number | null;
  oldTitle: string;
  newTitle: string;
}): Promise<void> {
  const oldTitle = args.oldTitle.trim();
  const newTitle = args.newTitle.trim();
  if (!oldTitle || !newTitle || oldTitle === newTitle) return;

  if (args.calEventTypeId != null) {
    await sql`
      UPDATE appointments
      SET service_name = CASE
        WHEN service_name ILIKE '% between %'
          THEN ${newTitle} || ' between ' || split_part(service_name, ' between ', 2)
        ELSE ${newTitle}
      END
      WHERE cal_event_type_id = ${args.calEventTypeId}
    `;
  }

  await sql`
    UPDATE appointments
    SET service_name = CASE
      WHEN service_name ILIKE '% between %'
        THEN ${newTitle} || ' between ' || split_part(service_name, ' between ', 2)
      ELSE ${newTitle}
    END
    WHERE cal_event_type_id IS NULL
      AND split_part(service_name, ' between ', 1) = ${oldTitle}
  `;
}
