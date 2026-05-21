'use client';

import { format, parseISO, startOfDay } from 'date-fns';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';

const TIME_FORMAT = 'h:mm a';
const DAY_HEADER_FORMAT = 'EEEE, MMMM d';

interface DayGroup {
  /** YYYY-MM-DD for valid dates, or 'unscheduled' as a sentinel. */
  key: string;
  /** Display label, e.g. "Monday, May 25" or "Unscheduled". */
  label: string;
  appointments: Appointment[];
}

/**
 * Bucket appointments by local-day. Returns groups sorted newest-first
 * with the 'Unscheduled' bucket (no booking_time) pinned at the bottom.
 * Each bucket's appointments are sorted ascending by time so the
 * earliest appointment of the day appears first within the group.
 */
function groupByDay(appointments: Appointment[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();

  for (const a of appointments) {
    if (!a.booking_time) {
      const k = 'unscheduled';
      if (!groups.has(k)) {
        groups.set(k, { key: k, label: 'Unscheduled', appointments: [] });
      }
      groups.get(k)!.appointments.push(a);
      continue;
    }
    const d = parseISO(a.booking_time);
    if (Number.isNaN(d.getTime())) continue;
    const key = format(startOfDay(d), 'yyyy-MM-dd');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: format(d, DAY_HEADER_FORMAT),
        appointments: [],
      });
    }
    groups.get(key)!.appointments.push(a);
  }

  for (const g of groups.values()) {
    g.appointments.sort((a, b) => {
      if (!a.booking_time) return 1;
      if (!b.booking_time) return -1;
      return (
        parseISO(a.booking_time).getTime() -
        parseISO(b.booking_time).getTime()
      );
    });
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.key === 'unscheduled') return 1;
    if (b.key === 'unscheduled') return -1;
    // YYYY-MM-DD strings sort lexicographically the same as by date.
    return b.key.localeCompare(a.key);
  });
}

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
  const groups = groupByDay(appointments);

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
                <AppointmentRow key={a.id} appointment={a} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function AppointmentRow({ appointment }: { appointment: Appointment }) {
  const time = appointment.booking_time
    ? format(parseISO(appointment.booking_time), TIME_FORMAT)
    : '—';
  return (
    <li className="grid grid-cols-[80px_1fr_auto] items-center gap-4 rounded-lg border border-stone-200 bg-white px-4 py-3 transition-shadow hover:shadow-sm">
      <span className="font-serif text-base text-stone-900">{time}</span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-stone-900">
          {clientDisplayName(
            appointment.client_first_name,
            appointment.client_last_name
          )}
        </p>
        <p className="mt-0.5 truncate text-xs text-stone-500">
          {cleanServiceName(appointment.service_name)}
        </p>
      </div>
      <StatusPill status={appointment.status} />
    </li>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const s = (status || '').toLowerCase();
  if (s === 'confirmed') {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700">
        Confirmed
      </span>
    );
  }
  if (s === 'cancelled') {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700">
        Cancelled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-600">
      {status || 'Unknown'}
    </span>
  );
}
