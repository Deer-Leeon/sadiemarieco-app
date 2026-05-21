'use client';

import { useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DayCell {
  date: Date;
  inCurrentMonth: boolean;
  isToday: boolean;
  appointments: Appointment[];
}

/**
 * Build a 7-column month grid that always renders complete weeks.
 *
 * `startOfWeek(startOfMonth, …)` rolls back to the previous Sunday so the
 * first row is full; `endOfWeek(endOfMonth, …)` rolls forward to the next
 * Saturday so the last row is full. Days outside the focused month are
 * still rendered, just visually de-emphasised.
 */
function buildCells(
  cursor: Date,
  appointments: Appointment[]
): DayCell[] {
  const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 });
  const gridEnd = endOfWeek(endOfMonth(cursor), { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  return days.map((d) => ({
    date: d,
    inCurrentMonth: isSameMonth(d, cursor),
    isToday: isToday(d),
    appointments: appointments
      .filter((a) => {
        if (!a.booking_time) return false;
        const at = parseISO(a.booking_time);
        if (Number.isNaN(at.getTime())) return false;
        return isSameDay(at, d);
      })
      .sort((a, b) => {
        // booking_time is guaranteed non-null here by the filter above.
        return (
          parseISO(a.booking_time as string).getTime() -
          parseISO(b.booking_time as string).getTime()
        );
      }),
  }));
}

/**
 * Month-view calendar grid.
 *
 * Scrolling contract: the day grid container (`flex-1 overflow-y-auto`)
 * is the only scrollable element in this view. Individual day cells use
 * adaptive heights — they grow with their content rather than introducing
 * nested scrollbars, which avoids the "mouse-wheel ambiguity" UX trap of
 * nested scroll containers.
 */
export default function CalendarView({
  appointments,
}: {
  appointments: Appointment[];
}) {
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const cells = useMemo(
    () => buildCells(cursor, appointments),
    [cursor, appointments]
  );

  return (
    <div className="flex h-full flex-col">
      {/* ── Month nav ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
        <h2 className="font-serif text-xl text-stone-900">
          {format(cursor, 'MMMM yyyy')}
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor((c) => subMonths(c, 1))}
            className="rounded-full border border-stone-200 bg-white p-1.5 text-stone-700 transition-colors hover:bg-stone-100"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(new Date())}
            className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setCursor((c) => addMonths(c, 1))}
            className="rounded-full border border-stone-200 bg-white p-1.5 text-stone-700 transition-colors hover:bg-stone-100"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Weekday header row ──────────────────────────────────────── */}
      <div className="grid grid-cols-7 border-b border-stone-200 px-6 py-2">
        {WEEKDAY_HEADERS.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500"
          >
            {d}
          </div>
        ))}
      </div>

      {/* ── Day grid (only scrollable element in this view) ─────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-7 gap-1 px-6 py-2">
          {cells.map((cell) => (
            <DayCellView key={cell.date.toISOString()} cell={cell} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayCellView({ cell }: { cell: DayCell }) {
  const base = cell.inCurrentMonth
    ? 'bg-white border-stone-200'
    : 'bg-stone-50/60 border-stone-100';
  const todayRing = cell.isToday ? 'ring-1 ring-stone-900/30' : '';

  const dayNumClass = cell.isToday
    ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[11px] font-medium text-stone-50'
    : cell.inCurrentMonth
      ? 'text-xs font-medium text-stone-700'
      : 'text-xs font-medium text-stone-400';

  return (
    <div
      className={`min-h-[100px] rounded-md border p-1.5 text-left ${base} ${todayRing}`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className={dayNumClass}>{format(cell.date, 'd')}</span>
        {cell.appointments.length > 0 && (
          <span className="text-[9px] text-stone-400">
            {cell.appointments.length}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {cell.appointments.map((a) => (
          <AppointmentPill key={a.id} appointment={a} />
        ))}
      </div>
    </div>
  );
}

function AppointmentPill({ appointment }: { appointment: Appointment }) {
  const status = (appointment.status || '').toLowerCase();
  const isCancelled = status === 'cancelled';
  const time = appointment.booking_time
    ? format(parseISO(appointment.booking_time), 'h:mm a')
    : '';
  const name = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  );
  const service = cleanServiceName(appointment.service_name);

  return (
    <button
      type="button"
      title={`${time ? time + ' · ' : ''}${name} — ${service}`}
      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] transition-colors ${
        isCancelled
          ? 'bg-amber-50 text-amber-700 line-through hover:bg-amber-100'
          : 'bg-stone-100 text-stone-800 hover:bg-stone-200'
      }`}
    >
      <span className="font-medium">{time}</span>{' '}
      <span className="text-stone-600">{name}</span>
    </button>
  );
}
