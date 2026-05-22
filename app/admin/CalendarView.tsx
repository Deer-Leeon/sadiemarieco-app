'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isSameDay,
  isToday,
  parseISO,
  startOfMonth,
} from 'date-fns';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Month window: render 6 months of history + current + 12 months ahead
 * (19 months total). This range covers a realistic studio's planning
 * horizon — long enough to look back at last fall's clients, far enough
 * forward to see a year of standing appointments — without ballooning
 * the initial DOM to thousands of day cells.
 *
 * If we ever need a true infinite scroll (load months as the user
 * approaches the edges), this is the right place to swap for an
 * IntersectionObserver-driven pager.
 */
const MONTHS_BEFORE = 6;
const MONTHS_AFTER = 12;
const TOTAL_MONTHS = MONTHS_BEFORE + 1 + MONTHS_AFTER; // 19

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface DayCell {
  date: Date;
  isToday: boolean;
  appointments: Appointment[];
}

interface MonthBlock {
  /** First day of the month (used as a stable React key & for formatting). */
  monthDate: Date;
  /** 0–6 — number of empty cells before the 1st (Sun = 0, Sat = 6). */
  leadingBlanks: number;
  /** Just the days that actually belong to this month; no spill-over. */
  cells: DayCell[];
  /** True for the single month containing today — anchor for initial scroll. */
  isCurrentMonth: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Data build
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the full 19-month window with appointment buckets per day.
 *
 * Apple-Calendar style: each month is a self-contained block whose first
 * row is offset by `leadingBlanks` empty cells (so the 1st appears in its
 * correct weekday column) and whose last row may end short of Saturday.
 * We deliberately do NOT pad with neighbouring-month days — that would
 * double-render the same date in two adjacent month grids and looks
 * confusing once the grids butt up to each other vertically.
 */
function buildMonths(now: Date, appointments: Appointment[]): MonthBlock[] {
  const nowMonthKey = format(now, 'yyyy-MM');
  const start = addMonths(startOfMonth(now), -MONTHS_BEFORE);

  return Array.from({ length: TOTAL_MONTHS }, (_, i) => {
    const monthDate = addMonths(start, i);
    const lastDay = endOfMonth(monthDate);
    const days = eachDayOfInterval({ start: monthDate, end: lastDay });

    const cells: DayCell[] = days.map((d) => {
      const buckets: Appointment[] = [];
      for (const a of appointments) {
        if (!a.booking_time) continue;
        const at = parseISO(a.booking_time);
        // Local-time comparison: TIMESTAMPTZ rows come out of Postgres in
        // UTC, parseISO returns Date in the JS runtime's local TZ, and
        // the studio's clock is the only meaningful "which day was this".
        if (Number.isNaN(at.getTime())) continue;
        if (isSameDay(at, d)) buckets.push(a);
      }
      buckets.sort(
        (a, b) =>
          parseISO(a.booking_time as string).getTime() -
          parseISO(b.booking_time as string).getTime()
      );
      return { date: d, isToday: isToday(d), appointments: buckets };
    });

    return {
      monthDate,
      leadingBlanks: getDay(monthDate),
      cells,
      isCurrentMonth: format(monthDate, 'yyyy-MM') === nowMonthKey,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

/**
 * Continuously-scrolling month view (Apple Calendar style).
 *
 * Architecture:
 *   - The weekday header sits OUTSIDE the scroll container, so it stays
 *     locked in place forever (no `sticky` needed → no z-index / blur
 *     stacking-context complications).
 *   - The scroll container is the only scrollable element in this view.
 *     Its scrollbar is hidden in both Webkit (`::-webkit-scrollbar`) and
 *     Gecko (`scrollbar-width`) for the Apple-style "scroll without
 *     visible controls" look.
 *   - On mount, we jump the scroll position to the top of the current
 *     month so the user lands on "today" instead of 6 months in the past.
 */
export default function CalendarView({
  appointments,
}: {
  appointments: Appointment[];
}) {
  // Compute `now` once on mount. If the dashboard stays open past
  // midnight the highlight may drift by a day until the user reloads —
  // acceptable trade-off vs. wiring a setInterval just for the "today"
  // ring. The same pattern is used in CalendarView's old single-month
  // implementation and ListView.
  const now = useMemo(() => new Date(), []);
  const months = useMemo(
    () => buildMonths(now, appointments),
    [now, appointments]
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentMonthRef = useRef<HTMLElement | null>(null);

  // Initial scroll alignment — runs once after the first paint. `offsetTop`
  // is measured against the scroll container (the offsetParent of the
  // section), so setting `scrollTop` directly is the cleanest way to
  // align without animating or using scrollIntoView (which would scroll
  // the entire page if the dashboard isn't `overflow: hidden` upstream).
  useEffect(() => {
    if (scrollRef.current && currentMonthRef.current) {
      scrollRef.current.scrollTop = currentMonthRef.current.offsetTop;
    }
    // Intentionally empty deps — run once on mount only. Re-running on
    // appointments change would yank the user back to today every time
    // the DB refreshes, which is wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col bg-[#FAF9F6]">
      {/* ── Locked weekday header ──────────────────────────────────── */}
      <div className="grid grid-cols-7 border-b border-stone-200 bg-[#FAF9F6] px-6 py-3">
        {WEEKDAY_HEADERS.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] font-semibold uppercase tracking-[0.28em] text-stone-500"
          >
            {d}
          </div>
        ))}
      </div>

      {/* ── Continuous-scroll month list ───────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pb-16 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {months.map((m) => (
          <section
            key={m.monthDate.toISOString()}
            ref={m.isCurrentMonth ? currentMonthRef : null}
          >
            <h2 className="mt-8 mb-4 font-serif text-2xl text-stone-900">
              {format(m.monthDate, 'MMMM yyyy')}
            </h2>
            <div className="grid grid-cols-7 gap-1">
              {/* Leading blanks push the 1st into its correct weekday column. */}
              {Array.from({ length: m.leadingBlanks }, (_, i) => (
                <div key={`blank-${i}`} aria-hidden="true" />
              ))}
              {m.cells.map((cell) => (
                <DayCellView key={cell.date.toISOString()} cell={cell} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Subcomponents
// ──────────────────────────────────────────────────────────────────────────

function DayCellView({ cell }: { cell: DayCell }) {
  const todayRing = cell.isToday ? 'ring-1 ring-stone-900/30' : '';
  const dayNumClass = cell.isToday
    ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[11px] font-medium text-stone-50'
    : 'text-xs font-medium text-stone-700';

  return (
    <div
      className={`min-h-[100px] rounded-md border border-stone-200 bg-white p-1.5 text-left ${todayRing}`}
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
