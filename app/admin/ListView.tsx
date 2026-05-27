'use client';

import type { Appointment } from './types';
import { groupAppointmentsByDay } from './groupAppointmentsByDay';
import { AppointmentListRow } from './AppointmentListRow';

/**
 * Day-grouped list view with sticky date headers.
 *
 * Scrolling contract: this is the ONLY scrollable container in this
 * view. The headers stay glued to the top of the viewport while their
 * group's appointments scroll past beneath them.
 */
export default function ListView({
  appointments,
}: {
  appointments: Appointment[];
}) {
  const groups = groupAppointmentsByDay(appointments);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {groups.map((group) => (
          <section key={group.key} className="mb-8 last:mb-12">
            <div className="sticky top-0 z-10 -mx-6 border-b border-stone-200/70 bg-[#FAF9F6]/95 px-6 py-2 backdrop-blur-sm">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500">
                {group.label}
              </h2>
            </div>
            <ul className="mt-4 space-y-2">
              {group.appointments.map((a) => (
                <AppointmentListRow key={a.id} appointment={a} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
