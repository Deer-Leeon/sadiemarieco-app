import { sql } from '@vercel/postgres';

import { appointmentServiceTitleKey } from '@/lib/appointment-service-title-key';
import { applyCatalogueTitleToServiceName } from '@/lib/catalogue-service-title';

/**
 * After a catalogue / Cal title change, rewrite stored appointment
 * names that still hold the old Cal snapshot so the admin calendar,
 * reminders, and SMS labels follow the new name.
 */
export async function rewriteAppointmentServiceNames(args: {
  calEventTypeId: number | null;
  oldTitle: string;
  newTitle: string;
}): Promise<{ updated: number }> {
  const oldTitle = args.oldTitle.trim();
  const newTitle = args.newTitle.trim();
  if (!oldTitle || !newTitle || oldTitle === newTitle) {
    return { updated: 0 };
  }

  let updated = 0;

  if (args.calEventTypeId != null) {
    const byId = await sql`
      UPDATE appointments
      SET service_name = CASE
        WHEN service_name ILIKE '% between %'
          THEN ${newTitle} || ' between ' || split_part(service_name, ' between ', 2)
        ELSE ${newTitle}
      END
      WHERE cal_event_type_id = ${args.calEventTypeId}
    `;
    updated += byId.rowCount ?? 0;
  }

  const byExact = await sql`
    UPDATE appointments
    SET service_name = CASE
      WHEN service_name ILIKE '% between %'
        THEN ${newTitle} || ' between ' || split_part(service_name, ' between ', 2)
      ELSE ${newTitle}
    END
    WHERE cal_event_type_id IS NULL
      AND split_part(service_name, ' between ', 1) = ${oldTitle}
  `;
  updated += byExact.rowCount ?? 0;

  const oldKey = appointmentServiceTitleKey(oldTitle);
  const newKey = appointmentServiceTitleKey(newTitle);
  if (!oldKey && !newKey) return { updated };

  const { rows: orphans } = await sql<{
    id: string;
    service_name: string | null;
  }>`
    SELECT id, service_name
    FROM appointments
    WHERE cal_event_type_id IS NULL
      AND service_name IS NOT NULL
  `;

  for (const row of orphans) {
    const key = appointmentServiceTitleKey(row.service_name);
    if (key !== oldKey && key !== newKey) continue;
    const next = applyCatalogueTitleToServiceName(row.service_name, newTitle);
    if (!next || next === row.service_name) continue;
    const result = await sql`
      UPDATE appointments
      SET service_name = ${next}
      WHERE id = ${row.id}
        AND cal_event_type_id IS NULL
    `;
    updated += result.rowCount ?? 0;
  }

  return { updated };
}
