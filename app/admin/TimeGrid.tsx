'use client';

import {
  addDays,
  format,
  isToday,
  startOfDay,
  startOfWeek,
} from 'date-fns';

import type { Appointment } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { getServiceColor } from './serviceColors';
import {
  HOURS,
  MIN_PILL_HEIGHT_PX,
  START_HOUR,
  layoutForDay,
  safeParseISO,
  type PositionedAppointment,
} from './timeline';

// ──────────────────────────────────────────────────────────────────────────
// Public component types
// ──────────────────────────────────────────────────────────────────────────
interface Props {
  appointments: Appointment[];
  /**
   * Anchor date. For `daysToShow={3}` the visible window starts at
   * `startOfDay(currentDate)` and extends two days forward (today + 2).
   * For `daysToShow={7}` we snap to the Sunday of the week containing
   * currentDate so the Week view is always a calendar-aligned Sun..Sat.
   */
  currentDate: Date;
  daysToShow: 3 | 7;
  /**
   * Fired when the user clicks the day-header cell (weekday name +
   * date number) at the top of a column. Receives the local-time
   * Date for that day (time portion is start-of-day). The time-grid
   * body below the header is NOT clickable — empty space inside a
   * day column intentionally does nothing, so the only ways to open
   * the day modal are (a) clicking the day header, or (b) clicking
   * an appointment pill (routed through `onAppointmentClick`).
   */
  onDayClick?: (date: Date) => void;
  /**
   * Fired when the user clicks a specific appointment pill. Receives
   * the bound Appointment so the parent can populate
   * AppointmentModal directly without re-looking-up by id.
   */
  onAppointmentClick?: (appointment: Appointment) => void;
}

interface DayColumn {
  date: Date;
  items: PositionedAppointment[];
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ──────────────────────────────────────────────────────────────────────────

function buildDays(currentDate: Date, daysToShow: 3 | 7): Date[] {
  const anchor =
    daysToShow === 7
      ? startOfWeek(currentDate, { weekStartsOn: 0 })
      : startOfDay(currentDate);
  return Array.from({ length: daysToShow }, (_, i) => addDays(anchor, i));
}

function buildColumns(
  days: Date[],
  appointments: Appointment[]
): DayColumn[] {
  return days.map((date) => ({
    date,
    items: layoutForDay(date, appointments),
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

/**
 * Google Calendar-style time-blocked view.
 *
 * Renders a fixed 7am..7pm working-day grid for either 3 days or a full
 * Sun..Sat week. Appointments are absolutely positioned inside their day
 * column using start/end timestamps from Postgres.
 *
 * Layout invariants:
 *   - The day-header row sits ABOVE the scroll region so it stays visible
 *     while the user scrolls vertically through hours.
 *   - Only the inner grid container scrolls; this respects DashboardUI's
 *     no-nested-scroll-outside-views contract.
 *   - Day columns are `position: relative`; appointments are absolutely
 *     positioned within them. Time labels live in their own column on
 *     the left so they scroll WITH the grid (so they line up with hours).
 *
 * Interactivity:
 *   - When `onDayClick` is supplied, the day-HEADER cell at the top
 *     of each column becomes a clickable surface (cursor-pointer,
 *     subtle hover tint, role="button" for screen readers,
 *     Enter/Space keyboard support).
 *   - The time-grid body itself is intentionally NOT clickable —
 *     dead clicks inside the grid were too easy to trigger by
 *     accident while scrolling, and the day-header gives a clearer
 *     affordance for "I want to focus on this day".
 *   - Appointment pills route their clicks to `onAppointmentClick`
 *     and stop propagation so they never bubble.
 */
export default function TimeGrid({
  appointments,
  currentDate,
  daysToShow,
  onDayClick,
  onAppointmentClick,
}: Props) {
  const days = buildDays(currentDate, daysToShow);
  const columns = buildColumns(days, appointments);

  // Same grid-template-columns string used by both the header row and
  // the body grid so columns line up perfectly across the divider.
  const gridTemplate = `60px repeat(${daysToShow}, minmax(0, 1fr))`;

  return (
    <div className="flex h-full flex-col bg-[#FAF9F6]">
      <div
        className="grid border-b border-stone-200 bg-[#FAF9F6]/95 backdrop-blur-sm"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div /> {/* corner spacer above the time-labels column */}
        {days.map((d) => (
          <DayHeader key={d.toISOString()} date={d} onClick={onDayClick} />
        ))}
      </div>

      {/* Grid body fills the remaining flex height. Two load-bearing
          bits:
            • `min-h-0` — without it, flex children refuse to shrink
              below their content size and you'd get a scrollbar again.
            • `gridTemplateRows: minmax(0, 1fr)` — the outer grid only
              has one row; without explicit row sizing it would shrink
              to content (`auto`), which then collapses the inner
              `repeat(HOURS, 1fr)` rows to zero. Forcing the row to
              `1fr` makes it fill the body, so every hour-cell below
              has a real height to scale into. */}
      <div
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: gridTemplate,
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
        <TimeLabelColumn />
        {columns.map((col) => (
          <DayColumnView
            key={col.date.toISOString()}
            column={col}
            onAppointmentClick={onAppointmentClick}
          />
        ))}
      </div>
    </div>
  );
}

function DayHeader({
  date,
  onClick,
}: {
  date: Date;
  onClick?: (date: Date) => void;
}) {
  const today = isToday(date);
  const clickable = !!onClick;

  const handleClick = () => onClick?.(date);
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(date);
    }
  };

  return (
    <div
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? handleKey : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={
        clickable
          ? `Open day view for ${format(date, 'EEEE, MMMM d')}`
          : undefined
      }
      className={`px-2 py-3 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/30 ${
        clickable
          ? 'cursor-pointer hover:bg-stone-100/70 active:bg-stone-200/60'
          : ''
      }`}
    >
      <div className="font-serif text-sm tracking-wide text-stone-900">
        {format(date, 'EEE')}
      </div>
      <div className="mt-1 flex items-center justify-center">
        <span
          className={
            today
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 font-serif text-sm text-stone-50'
              : 'font-serif text-xl text-stone-900'
          }
        >
          {format(date, 'd')}
        </span>
      </div>
    </div>
  );
}

function TimeLabelColumn() {
  return (
    <div
      className="grid border-r border-stone-200"
      style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: HOURS }, (_, i) => {
        const hour = START_HOUR + i;
        const labelDate = new Date();
        labelDate.setHours(hour, 0, 0, 0);
        return (
          <div
            key={hour}
            className="border-t border-stone-200 pr-2 pt-1 text-right text-[10px] uppercase tracking-widest text-stone-400"
          >
            {format(labelDate, 'h a')}
          </div>
        );
      })}
    </div>
  );
}

function DayColumnView({
  column,
  onAppointmentClick,
}: {
  column: DayColumn;
  onAppointmentClick?: (appointment: Appointment) => void;
}) {
  // Day-column body is intentionally inert. The only clickable
  // surfaces inside the time grid are (1) the day header above
  // (handled in DayHeader) and (2) the appointment pills below.
  //
  // Layered structure:
  //   * `.relative` parent — owns the appointment-pill coordinate
  //     space (percentages are computed against THIS element's height).
  //   * inner `.absolute inset-0` grid — paints the hour gridlines
  //     using `repeat(HOURS, 1fr)` so they stretch to fill any height.
  //   * pills — absolutely positioned with topPct/heightPct, layered
  //     above the gridlines.
  return (
    <div className="relative border-l border-stone-200">
      <div
        className="pointer-events-none absolute inset-0 grid"
        style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: HOURS }, (_, i) => (
          <div key={i} className="border-t border-stone-200" />
        ))}
      </div>
      {column.items.map((pa) => (
        <AppointmentBlock
          key={pa.appointment.id}
          positioned={pa}
          onClick={onAppointmentClick}
        />
      ))}
    </div>
  );
}

function AppointmentBlock({
  positioned,
  onClick,
}: {
  positioned: PositionedAppointment;
  onClick?: (appointment: Appointment) => void;
}) {
  const { appointment: apt, topPct, heightPct, col, totalCols } = positioned;
  // Canceled rows (admin- or client-initiated) are filtered out
  // upstream in DashboardUI, so they never reach this pill. No-show
  // rows DO render — with a struck-through, greyed-out treatment so
  // the wasted slot stays visible without pretending it's bookable.
  const isNoShow = (apt.status || '').toLowerCase() === 'no-show';

  const start = safeParseISO(apt.booking_time);
  const end = safeParseISO(apt.end_time);
  const timeLabel = start
    ? end
      ? `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`
      : format(start, 'h:mm a')
    : '';

  const name = clientDisplayName(apt.client_first_name, apt.client_last_name);
  const service = appointmentServiceLabel(apt);

  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;

  // stopPropagation is defensive — the day-column body no longer
  // has its own click handler (only the day-header at the top of
  // the column does), but stopping the bubble here keeps the pill
  // self-contained against any future ancestor handler.
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClick?.(apt);
  };
  const clickable = !!onClick;

  // Service-type colour coding: the whole pill is painted in the
  // assigned hex. Foreground text auto-flips to white or stone based
  // on luminance (see makeColor in serviceColors.ts). No-show pills
  // keep the neutral grey treatment so the wasted slot reads as
  // "this didn't happen" regardless of what was booked. Unmapped
  // services fall back to the original stone palette.
  const color = isNoShow ? null : getServiceColor(apt);
  const baseClasses =
    'absolute overflow-hidden rounded-sm p-1.5 shadow-sm transition-colors text-left';
  const variantClasses = isNoShow
    ? 'border-l-[3px] border-stone-400 bg-stone-50 opacity-60'
    : color
      ? ''
      : 'border-l-[3px] border-stone-800 bg-stone-100';
  const interactiveClasses = clickable
    ? 'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-stone-900/40'
    : 'pointer-events-none';

  return (
    <button
      type="button"
      onClick={clickable ? handleClick : undefined}
      disabled={!clickable}
      className={`${baseClasses} ${variantClasses} ${interactiveClasses}`}
      title={`${timeLabel}${timeLabel ? ' · ' : ''}${name} — ${service}${isNoShow ? ' (no-show)' : ''}`}
      aria-label={`Open booking: ${name}, ${service}${timeLabel ? `, ${timeLabel}` : ''}${isNoShow ? ', no-show' : ''}`}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        minHeight: MIN_PILL_HEIGHT_PX,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        ...(color && {
          backgroundColor: color.accent,
          color: color.text,
        }),
      }}
    >
      <div
        className={`truncate text-xs font-medium ${
          isNoShow
            ? 'text-gray-400 line-through'
            : color
              ? ''
              : 'text-stone-900'
        }`}
        style={color ? { color: color.text } : undefined}
      >
        {name}
      </div>
      <div
        className={`truncate text-[10px] ${
          isNoShow
            ? 'text-gray-400 line-through'
            : color
              ? ''
              : 'text-stone-500'
        }`}
        style={color ? { color: color.textMuted } : undefined}
      >
        {timeLabel}
        {timeLabel && service ? ' · ' : ''}
        {service}
      </div>
    </button>
  );
}
