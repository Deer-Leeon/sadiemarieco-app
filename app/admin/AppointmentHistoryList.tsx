'use client';

import type { Appointment } from './types';
import { AppointmentListRow } from './AppointmentListRow';
import { groupAppointmentsByDay } from './groupAppointmentsByDay';

/**
 * Day-grouped appointment list matching /admin bookings ListView chrome.
 */
export default function AppointmentHistoryList({
  appointments,
  dayOrder,
  onSelect,
  stickyHeaders = false,
}: {
  appointments: Appointment[];
  dayOrder: 'asc' | 'desc';
  onSelect?: (a: Appointment) => void;
  /** Sticky day headers (bookings list scroll container). */
  stickyHeaders?: boolean;
}) {
  const groups = groupAppointmentsByDay(appointments, { dayOrder });

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="mb-8 last:mb-0">
          <div
            className={
              stickyHeaders
                ? 'sticky top-0 z-10 -mx-6 border-b border-stone-200/70 bg-[#FAF9F6]/95 px-6 py-2 backdrop-blur-sm'
                : 'border-b border-stone-200/70 pb-2'
            }
          >
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500">
              {group.label}
            </h2>
          </div>
          <ul className="mt-4 space-y-2">
            {group.appointments.map((a) => (
              <AppointmentListRow
                key={a.id}
                appointment={a}
                variant="client"
                onSelect={onSelect ? () => onSelect(a) : undefined}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
