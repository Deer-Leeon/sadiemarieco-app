'use client';

import { useEffect, useMemo, useRef } from 'react';
import { parseISO } from 'date-fns';
import { Flag } from 'lucide-react';

import {
  addStudioCalendarDays,
  calendarDayUtcNoon,
  daysInStudioMonth,
  formatStudioClock,
  formatStudioDayOfMonth,
  formatStudioMonthYear,
  startOfStudioMonthKey,
  studioDateKey,
  studioMonthKey,
  studioWeekdaySun0,
  todayStudioDateKey,
} from '@/lib/studio-calendar';

import type { Appointment } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { getServiceColor } from './serviceColors';

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
  /** YYYY-MM-DD in America/Denver. */
  dateKey: string;
  date: Date;
  isToday: boolean;
  appointments: Appointment[];
}

interface MonthBlock {
  /** First day of the month (UTC-noon Date used as React key). */
  monthDate: Date;
  monthKey: string;
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
 *
 * Day membership and "today" are America/Denver — never the runtime TZ
 * (Vercel SSR is UTC and would highlight tomorrow after ~6pm Mountain).
 */
function buildMonths(
  todayKey: string,
  appointments: Appointment[]
): MonthBlock[] {
  const nowMonthKey = studioMonthKey(todayKey);
  const startMonthKey = (() => {
    const [y, m] = startOfStudioMonthKey(todayKey).split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1 - MONTHS_BEFORE, 1, 12));
    const yy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
    return `${yy}-${mm}-01`;
  })();

  // Pre-bucket appointments by studio date once (O(appts) not O(days×appts)).
  const byDay = new Map<string, Appointment[]>();
  for (const a of appointments) {
    if (!a.booking_time) continue;
    const key = studioDateKey(a.booking_time);
    if (!key) continue;
    const list = byDay.get(key);
    if (list) list.push(a);
    else byDay.set(key, [a]);
  }
  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        parseISO(a.booking_time as string).getTime() -
        parseISO(b.booking_time as string).getTime()
    );
  }

  return Array.from({ length: TOTAL_MONTHS }, (_, i) => {
    const [sy, sm] = startMonthKey.split('-').map(Number);
    const monthStart = new Date(Date.UTC(sy, sm - 1 + i, 1, 12));
    const yy = monthStart.getUTCFullYear();
    const mm = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
    const monthFirstKey = `${yy}-${mm}-01`;
    const monthKey = `${yy}-${mm}`;
    const dayCount = daysInStudioMonth(monthFirstKey);

    const cells: DayCell[] = Array.from({ length: dayCount }, (_, dayIdx) => {
      const dateKey = addStudioCalendarDays(monthFirstKey, dayIdx);
      return {
        dateKey,
        date: calendarDayUtcNoon(dateKey),
        isToday: dateKey === todayKey,
        appointments: byDay.get(dateKey) ?? [],
      };
    });

    return {
      monthDate: calendarDayUtcNoon(monthFirstKey),
      monthKey,
      leadingBlanks: studioWeekdaySun0(monthFirstKey),
      cells,
      isCurrentMonth: monthKey === nowMonthKey,
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
  onAppointmentClick,
}: {
  appointments: Appointment[];
  /**
   * Fired when the user clicks any appointment pill anywhere in the
   * month grid. Bubbles the bound Appointment up to DashboardUI so
   * the AppointmentModal can render on top of the calendar without
   * the month view having to know anything about the modal itself.
   */
  onAppointmentClick?: (appointment: Appointment) => void;
}) {
  // Studio "today" once per mount. If the dashboard stays open past
  // midnight Mountain the highlight may drift by a day until reload —
  // acceptable vs. wiring a setInterval just for the ring.
  const todayKey = useMemo(() => todayStudioDateKey(), []);
  const months = useMemo(
    () => buildMonths(todayKey, appointments),
    [todayKey, appointments]
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
            key={m.monthKey}
            ref={m.isCurrentMonth ? currentMonthRef : null}
          >
            <h2 className="mt-8 mb-4 font-serif text-2xl text-stone-900">
              {formatStudioMonthYear(`${m.monthKey}-01`)}
            </h2>
            <div className="grid grid-cols-7 gap-1">
              {/* Leading blanks push the 1st into its correct weekday column. */}
              {Array.from({ length: m.leadingBlanks }, (_, i) => (
                <div key={`blank-${i}`} aria-hidden="true" />
              ))}
              {m.cells.map((cell) => (
                <DayCellView
                  key={cell.dateKey}
                  cell={cell}
                  onAppointmentClick={onAppointmentClick}
                />
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

function DayCellView({
  cell,
  onAppointmentClick,
}: {
  cell: DayCell;
  onAppointmentClick?: (appointment: Appointment) => void;
}) {
  const todayRing = cell.isToday ? 'ring-1 ring-stone-900/30' : '';
  const dayNumClass = cell.isToday
    ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[11px] font-medium text-stone-50'
    : 'text-xs font-medium text-stone-700';

  return (
    <div
      className={`min-h-[100px] rounded-md border border-stone-200 bg-white p-1.5 text-left ${todayRing}`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className={dayNumClass}>
          {formatStudioDayOfMonth(cell.dateKey)}
        </span>
        {cell.appointments.length > 0 && (
          <span className="text-[9px] text-stone-400">
            {cell.appointments.length}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {cell.appointments.map((a) => (
          <AppointmentPill
            key={a.id}
            appointment={a}
            onClick={onAppointmentClick}
          />
        ))}
      </div>
    </div>
  );
}

function AppointmentPill({
  appointment,
  onClick,
}: {
  appointment: Appointment;
  onClick?: (appointment: Appointment) => void;
}) {
  // Canceled rows are filtered upstream in DashboardUI before they
  // ever reach CalendarView, so the visual special-cases here are
  // no-show (strikethrough) and pending (dashed ring / awaiting).
  const status = (appointment.status || '').toLowerCase();
  const isNoShow = status === 'no-show';
  const isPending = status === 'pending';
  const hasNoShowFlag = Boolean(appointment.client_no_show_flag);
  const time = appointment.booking_time
    ? formatStudioClock(appointment.booking_time)
    : '';
  const name = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  );
  const service = appointmentServiceLabel(appointment);

  // The pill is already a <button>; we just bind the click. No
  // stopPropagation needed in the month view because the parent cell
  // doesn't have its own click handler (unlike the time-grid columns).
  const handleClick = () => onClick?.(appointment);

  // Month-grid pills are 10px tall one-liners painted with the full
  // service-type colour — the auto-contrast text (white vs stone)
  // baked into makeColor keeps both the time stamp and the client
  // name legible on every hue in the palette.
  const color = isNoShow ? null : getServiceColor(appointment);
  const colorStyle = color
    ? { backgroundColor: color.accent, color: color.text }
    : undefined;
  const pendingSuffix = isPending ? ' (awaiting payment)' : '';

  return (
    <button
      type="button"
      onClick={onClick ? handleClick : undefined}
      title={`${time ? time + ' · ' : ''}${name} — ${service}${isNoShow ? ' (no-show)' : ''}${pendingSuffix}${hasNoShowFlag ? ' · flagged' : ''}`}
      aria-label={`Open booking: ${name}, ${service}${time ? `, ${time}` : ''}${isNoShow ? ', no-show' : ''}${isPending ? ', awaiting payment' : ''}${hasNoShowFlag ? ', no-show flag' : ''}`}
      className={`relative block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] transition-colors ${
        isNoShow
          ? 'bg-stone-50 text-gray-400 line-through opacity-60 hover:bg-stone-100'
          : color
            ? 'hover:brightness-95'
            : 'bg-stone-100 text-stone-800 hover:bg-stone-200'
      } ${hasNoShowFlag && !isNoShow ? 'ring-1 ring-inset ring-amber-400/70' : ''} ${
        isPending ? 'opacity-80 ring-1 ring-inset ring-dashed ring-stone-900/35' : ''
      } ${onClick ? 'cursor-pointer' : ''}`}
      style={colorStyle}
    >
      {hasNoShowFlag ? (
        <Flag
          className="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 text-amber-800"
          strokeWidth={2.6}
          aria-hidden="true"
        />
      ) : null}
      <span className="font-medium">{time}</span>{' '}
      <span
        className={isNoShow ? 'text-gray-400' : color ? '' : 'text-stone-600'}
        style={color ? { color: color.textMuted } : undefined}
      >
        {name}
      </span>
    </button>
  );
}
