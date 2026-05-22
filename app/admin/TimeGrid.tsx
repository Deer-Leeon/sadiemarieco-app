'use client';

import {
  addDays,
  format,
  isToday,
  startOfDay,
  startOfWeek,
} from 'date-fns';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';
import {
  GRID_HEIGHT_PX,
  HOUR_HEIGHT_PX,
  HOURS,
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
   * Fired when the user clicks anywhere inside a day column. Receives
   * the local-time Date for that day (time portion is start-of-day).
   * Bubbling: clicks on appointment pills also bubble up here — that
   * matches the spec ("the entire column for a specific day should be
   * clickable") and gives the user the same "open the modal" affordance
   * whether they click an empty hour slot or an existing pill.
   */
  onDayClick?: (date: Date) => void;
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
 *   - When `onDayClick` is supplied, day columns become clickable
 *     surfaces (cursor-pointer, subtle hover tint, role="button" for
 *     screen readers, Enter/Space keyboard support).
 */
export default function TimeGrid({
  appointments,
  currentDate,
  daysToShow,
  onDayClick,
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
          <DayHeader key={d.toISOString()} date={d} />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: gridTemplate,
            height: GRID_HEIGHT_PX,
          }}
        >
          <TimeLabelColumn />
          {columns.map((col) => (
            <DayColumnView
              key={col.date.toISOString()}
              column={col}
              onClick={onDayClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayHeader({ date }: { date: Date }) {
  const today = isToday(date);
  return (
    <div className="px-2 py-3 text-center">
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
    <div className="border-r border-stone-200">
      {Array.from({ length: HOURS }, (_, i) => {
        const hour = START_HOUR + i;
        const labelDate = new Date();
        labelDate.setHours(hour, 0, 0, 0);
        return (
          <div
            key={hour}
            className="border-t border-stone-200 pr-2 pt-1 text-right text-[10px] uppercase tracking-widest text-stone-400"
            style={{ height: HOUR_HEIGHT_PX }}
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
  onClick,
}: {
  column: DayColumn;
  onClick?: (date: Date) => void;
}) {
  const clickable = !!onClick;
  const handleClick = () => onClick?.(column.date);
  // Standard div-as-button accessibility shim: when no real <button>
  // wrapper is available (because we need the relative container with
  // absolutely-positioned pills inside), expose ARIA + keyboard handlers.
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(column.date);
    }
  };

  return (
    <div
      className={`relative border-l border-stone-200 transition-colors ${
        clickable ? 'cursor-pointer hover:bg-stone-50' : ''
      }`}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? handleKey : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={
        clickable
          ? `Open day view for ${format(column.date, 'EEEE, MMMM d')}`
          : undefined
      }
    >
      {Array.from({ length: HOURS }, (_, i) => (
        <div
          key={i}
          className="border-t border-stone-200"
          style={{ height: HOUR_HEIGHT_PX }}
        />
      ))}
      {column.items.map((pa) => (
        <AppointmentBlock key={pa.appointment.id} positioned={pa} />
      ))}
    </div>
  );
}

function AppointmentBlock({
  positioned,
}: {
  positioned: PositionedAppointment;
}) {
  const { appointment: apt, top, height, col, totalCols } = positioned;
  const cancelled = (apt.status || '').toLowerCase() === 'cancelled';

  const start = safeParseISO(apt.booking_time);
  const end = safeParseISO(apt.end_time);
  const timeLabel = start
    ? end
      ? `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`
      : format(start, 'h:mm a')
    : '';

  const name = clientDisplayName(apt.client_first_name, apt.client_last_name);
  const service = cleanServiceName(apt.service_name);

  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;

  const baseClasses =
    'absolute overflow-hidden rounded-sm p-1.5 shadow-sm transition-colors pointer-events-none';
  const variantClasses = cancelled
    ? 'border-l-[3px] border-amber-700 bg-amber-50'
    : 'border-l-[3px] border-stone-800 bg-stone-100';

  return (
    <div
      className={`${baseClasses} ${variantClasses}`}
      title={`${timeLabel}${timeLabel ? ' · ' : ''}${name} — ${service}`}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
      }}
    >
      <div
        className={`truncate text-xs font-medium ${
          cancelled ? 'text-amber-800 line-through' : 'text-stone-900'
        }`}
      >
        {name}
      </div>
      <div
        className={`truncate text-[10px] ${
          cancelled ? 'text-amber-700' : 'text-stone-500'
        }`}
      >
        {timeLabel}
        {timeLabel && service ? ' · ' : ''}
        {service}
      </div>
    </div>
  );
}
