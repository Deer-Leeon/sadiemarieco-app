'use client';

import { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';

import {
  addStudioCalendarDays,
  calendarDayUtcNoon,
  formatStudioClock,
  formatStudioClockRange,
  formatStudioDayOfMonth,
  formatStudioWeekdayShort,
  isStudioToday,
  studioDateKey,
  studioWeekdaySun0,
} from '@/lib/studio-calendar';

import type { Appointment, TimeBlock } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import ClosedHoursHatch from './components/ClosedHoursHatch';
import { SettlementCheckMarker } from './components/SettlementMarker';
import TimeBlockPill from './components/TimeBlockPill';
import { settlementAriaLabel } from './settlementDisplay';
import { getServiceColor } from './serviceColors';
import {
  HOURS,
  MIN_PILL_HEIGHT_PX,
  START_HOUR,
  closedBandPercentsForDay,
  layoutBlocksForDay,
  layoutForDay,
  overlapLaneBoxStyle,
  overlapLaneCascadeStyle,
  PHONE_CALENDAR_MQ,
  safeParseISO,
  type PositionedAppointment,
  type PositionedTimeBlock,
} from './timeline';
import type {
  StudioAvailabilityBlock,
  StudioDateOverride,
} from '@/lib/studio-schedule-windows';

// ──────────────────────────────────────────────────────────────────────────
// Public component types
// ──────────────────────────────────────────────────────────────────────────
interface Props {
  appointments: Appointment[];
  timeBlocks: TimeBlock[];
  removingBlockId?: string | null;
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
   * Date for that day (time portion is start-of-day). Empty hour
   * bands in the column body fire `onHourClick` instead.
   */
  onDayClick?: (date: Date) => void;
  /**
   * Fired when the user clicks a specific appointment pill. Receives
   * the bound Appointment so the parent can populate
   * AppointmentModal directly without re-looking-up by id.
   */
  onAppointmentClick?: (appointment: Appointment) => void;
  /** Fired when the user clicks a blocked-time pill. */
  onBlockClick?: (block: TimeBlock) => void;
  /**
   * Empty hour-band click inside a day column (behind pills). Receives
   * the column's studio date and the hour (9–20).
   */
  onHourClick?: (date: Date, hour: number) => void;
  /** Official weekly hours. Null until GET /api/admin/availability returns. */
  scheduleAvailability?: StudioAvailabilityBlock[] | null;
  /** Date overrides. Null until the schedule has loaded. */
  scheduleOverrides?: StudioDateOverride[] | null;
}

interface DayColumn {
  date: Date;
  items: PositionedAppointment[];
  blocks: PositionedTimeBlock[];
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ──────────────────────────────────────────────────────────────────────────

function buildDays(currentDate: Date, daysToShow: 3 | 7): Date[] {
  let startKey = studioDateKey(currentDate);
  if (!startKey) {
    // Fallback — shouldn't happen with a real Date.
    startKey = studioDateKey(new Date());
  }
  if (daysToShow === 7) {
    startKey = addStudioCalendarDays(startKey, -studioWeekdaySun0(startKey));
  }
  return Array.from({ length: daysToShow }, (_, i) =>
    calendarDayUtcNoon(addStudioCalendarDays(startKey, i))
  );
}

function buildColumns(
  days: Date[],
  appointments: Appointment[],
  timeBlocks: TimeBlock[]
): DayColumn[] {
  return days.map((date) => ({
    date,
    items: layoutForDay(date, appointments),
    blocks: layoutBlocksForDay(date, timeBlocks),
  }));
}

function usePhoneCalendar(): boolean {
  const [isPhone, setIsPhone] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(PHONE_CALENDAR_MQ).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(PHONE_CALENDAR_MQ);
    const apply = () => setIsPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return isPhone;
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
 *     of each column becomes a clickable surface.
 *   - Empty hour bands in the column body open the appointment booker
 *     (`onHourClick`) when supplied. Appointment and block pills sit
 *     above those bands and keep their own click handlers.
 *   - Appointment pills route their clicks to `onAppointmentClick`
 *     and stop propagation so they never bubble.
 */
export default function TimeGrid({
  appointments,
  timeBlocks,
  removingBlockId = null,
  currentDate,
  daysToShow,
  onDayClick,
  onAppointmentClick,
  onBlockClick,
  onHourClick,
  scheduleAvailability = null,
  scheduleOverrides = null,
}: Props) {
  const days = buildDays(currentDate, daysToShow);
  const columns = buildColumns(days, appointments, timeBlocks);
  const cascadeOverlap = usePhoneCalendar();

  // Same grid-template-columns string used by both the header row and
  // the body grid so columns line up perfectly across the divider.
  const gridTemplate = `60px repeat(${daysToShow}, minmax(0, 1fr))`;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#FAF9F6]">
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
            removingBlockId={removingBlockId}
            onAppointmentClick={onAppointmentClick}
            onBlockClick={onBlockClick}
            onHourClick={onHourClick}
            hatchBands={closedBandPercentsForDay(
              col.date,
              col.items.map((item) => item.appointment),
              scheduleAvailability,
              scheduleOverrides
            )}
            cascadeOverlap={cascadeOverlap}
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
  const today = isStudioToday(date);
  const clickable = !!onClick;
  const dateKey = studioDateKey(date);
  const weekday = formatStudioWeekdayShort(dateKey || date);
  const dayNum = formatStudioDayOfMonth(dateKey || date);

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
        clickable ? `Open day view for ${weekday} ${dayNum}` : undefined
      }
      className={`px-2 py-3 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/30 ${
        clickable
          ? 'cursor-pointer hover:bg-stone-100/70 active:bg-stone-200/60'
          : ''
      }`}
    >
      <div className="font-serif text-sm tracking-wide text-stone-900">
        {weekday}
      </div>
      <div className="mt-1 flex items-center justify-center">
        <span
          className={
            today
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 font-serif text-sm text-stone-50'
              : 'font-serif text-xl text-stone-900'
          }
        >
          {dayNum}
        </span>
      </div>
    </div>
  );
}

const HOUR_LABELS = [
  '9 AM',
  '10 AM',
  '11 AM',
  '12 PM',
  '1 PM',
  '2 PM',
  '3 PM',
  '4 PM',
  '5 PM',
  '6 PM',
  '7 PM',
  '8 PM',
] as const;

function TimeLabelColumn() {
  return (
    <div
      className="grid border-r border-stone-200"
      style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: HOURS }, (_, i) => {
        const hour = START_HOUR + i;
        return (
          <div
            key={hour}
            className="border-t border-stone-200 pr-2 pt-1 text-right text-[10px] uppercase tracking-widest text-stone-400"
          >
            {HOUR_LABELS[i]}
          </div>
        );
      })}
    </div>
  );
}

function DayColumnView({
  column,
  removingBlockId,
  onAppointmentClick,
  onBlockClick,
  onHourClick,
  hatchBands,
  cascadeOverlap,
}: {
  column: DayColumn;
  removingBlockId: string | null;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
  onHourClick?: (date: Date, hour: number) => void;
  hatchBands: { topPct: number; heightPct: number }[];
  cascadeOverlap: boolean;
}) {
  // Layered structure:
  //   * `.relative` parent — appointment-pill coordinate space.
  //   * closed-hours hatch — background wash behind hour lines.
  //   * hour-band buttons (z-[2]) — empty-space clicks open the booker.
  //   * inner gridlines — pointer-events-none so they don't steal clicks.
  //   * blocks (z-10) and appointment pills (z-20) sit above the bands.
  return (
    <div className="relative border-l border-stone-200">
      <ClosedHoursHatch bands={hatchBands} />
      <div
        className="pointer-events-none absolute inset-0 z-1 grid"
        style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: HOURS }, (_, i) => (
          <div key={i} className="border-t border-stone-200" />
        ))}
      </div>
      {onHourClick ? (
        <div
          className="absolute inset-0 z-2 grid"
          style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: HOURS }, (_, i) => {
            const hour = START_HOUR + i;
            const suffix =
              hour === 0
                ? '12 AM'
                : hour < 12
                  ? `${hour} AM`
                  : hour === 12
                    ? '12 PM'
                    : `${hour - 12} PM`;
            return (
              <button
                key={hour}
                type="button"
                aria-label={`Book or block time starting at ${suffix}`}
                className="w-full border-t border-transparent transition-colors hover:bg-stone-900/[0.04] focus:outline-none focus-visible:bg-stone-900/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-400/60"
                onClick={() => onHourClick(column.date, hour)}
              />
            );
          })}
        </div>
      ) : null}
      {column.blocks.map((pb) => (
        <TimeBlockPill
          key={pb.block.id}
          block={pb.block}
          topPct={pb.topPct}
          heightPct={pb.heightPct}
          compact
          removing={removingBlockId === pb.block.id}
          className="ml-0.5 w-[calc(100%-4px)]"
          onClick={onBlockClick ? () => onBlockClick(pb.block) : undefined}
        />
      ))}
      {column.items.map((pa) => (
        <AppointmentBlock
          key={pa.appointment.id}
          positioned={pa}
          onClick={onAppointmentClick}
          cascadeOverlap={cascadeOverlap}
        />
      ))}
    </div>
  );
}

/** Vertical room for a second line of type inside a time-grid pill. */
function canStackPillLines(
  durationMinutes: number | null,
  heightPct: number
): boolean {
  if (durationMinutes != null && durationMinutes < 40) return false;
  if (heightPct < 5) return false;
  return true;
}

/** Whether the secondary copy should include the service name. */
function includeServiceOnPill(
  durationMinutes: number | null,
  heightPct: number,
  stacked: boolean
): boolean {
  if (!stacked) {
    // Single-line pills (esp. 3-day) have horizontal room — show service
    // and let truncate clip if the column is narrow.
    return true;
  }
  return (
    (durationMinutes != null && durationMinutes >= 90) || heightPct >= 9
  );
}

function AppointmentBlock({
  positioned,
  onClick,
  cascadeOverlap,
}: {
  positioned: PositionedAppointment;
  onClick?: (appointment: Appointment) => void;
  cascadeOverlap: boolean;
}) {
  const { appointment: apt, topPct, heightPct, col, totalCols } = positioned;
  // Canceled rows (admin- or client-initiated) and pending checkout
  // holds are filtered out upstream in DashboardUI, so they never
  // reach this pill. No-show rows DO render — with a struck-through,
  // greyed-out treatment so the wasted slot stays visible without
  // pretending it's bookable.
  const statusLower = (apt.status || '').toLowerCase();
  const isNoShow = statusLower === 'no-show';
  const hasNoShowFlag = Boolean(apt.client_no_show_flag);

  const start = safeParseISO(apt.booking_time);
  const end = safeParseISO(apt.end_time);
  const timeLabel = start
    ? formatStudioClockRange(start, end)
    : '';
  const startLabel = start ? formatStudioClock(start) : '';
  const durationMinutes =
    start && end
      ? Math.max(0, (end.getTime() - start.getTime()) / 60_000)
      : null;

  const fullName = clientDisplayName(apt.client_first_name, apt.client_last_name);
  const service = appointmentServiceLabel(apt);
  const overlapping = totalCols > 1;
  const compactLabel = cascadeOverlap && overlapping;
  const peekingUnder = compactLabel && col === 0;
  const name = compactLabel
    ? (apt.client_first_name?.trim() || fullName)
    : fullName;
  const stacked = !compactLabel && canStackPillLines(durationMinutes, heightPct);
  const showService =
    !compactLabel &&
    includeServiceOnPill(durationMinutes, heightPct, stacked);
  const detailBits = compactLabel
    ? peekingUnder
      ? ''
      : startLabel
    : [timeLabel, showService ? service : ''].filter(Boolean).join(' · ');

  const laneBox = cascadeOverlap
    ? overlapLaneCascadeStyle(col, totalCols)
    : overlapLaneBoxStyle(col, totalCols);

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
  // assigned hex. Foreground text auto-flips to white or black based
  // on YIQ luminance (see serviceColors.ts). No-show pills keep the
  // neutral grey treatment so the wasted slot reads as "this didn't
  // happen" regardless of what was booked. Unmapped services fall
  // back to the original stone palette.
  const color = isNoShow ? null : getServiceColor(apt);
  // Match SingleDayModal pills: solid fill, no black outline. Gap between
  // back-to-back same-colour bookings comes from layout packing / height,
  // not a stroke. No-show and unmapped services keep a left accent stripe.
  const overlapShadow =
    overlapping && cascadeOverlap
      ? col > 0
        ? '0 1px 1px rgba(28,25,23,0.06), 0 4px 12px rgba(28,25,23,0.12), 0 0 0 1px rgba(255,255,255,0.75)'
        : '0 0 0 1px rgba(255,255,255,0.5)'
      : undefined;
  const baseClasses = overlapping
    ? 'absolute overflow-hidden rounded-sm text-left leading-none transition-colors'
    : 'absolute z-20 overflow-hidden rounded-sm p-1.5 shadow-sm transition-colors text-left leading-tight';
  const variantClasses = isNoShow
    ? 'border-l-[3px] border-l-stone-400 bg-stone-50 opacity-60'
    : color
      ? ''
      : 'border-l-[3px] border-l-stone-800 bg-stone-100';
  const flaggedClasses = hasNoShowFlag && !isNoShow
    ? 'ring-1 ring-inset ring-amber-400/70'
    : '';
  const interactiveClasses = clickable
    ? 'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-stone-900/40'
    : 'pointer-events-none';

  const nameClass = `truncate ${
    compactLabel ? 'text-[10px] font-semibold leading-none' : 'text-xs font-semibold'
  } ${
    isNoShow
      ? 'text-gray-400 line-through'
      : color
        ? ''
        : 'text-stone-900'
  }`;
  const mutedClass = `${compactLabel ? 'text-[9px] leading-none' : 'text-[10px]'} ${
    isNoShow
      ? 'text-gray-400 line-through'
      : color
        ? ''
        : 'text-stone-600'
  }`;
  const nameStyle = color ? { color: color.text } : undefined;
  const mutedStyle = color ? { color: color.textMuted } : undefined;
  const flagSuffix = hasNoShowFlag ? ', no-show flag' : '';
  const settledLabel = settlementAriaLabel(apt.terminal_payment);
  const settledSuffix = settledLabel ? `, ${settledLabel}` : '';

  return (
    <button
      type="button"
      onClick={clickable ? handleClick : undefined}
      disabled={!clickable}
      className={`${baseClasses} ${variantClasses} ${flaggedClasses} ${interactiveClasses} ${
        overlapping ? (peekingUnder ? 'px-1 py-0.5' : 'px-1 py-1') : ''
      }`}
      title={`${timeLabel}${timeLabel ? ' · ' : ''}${fullName} — ${service}${isNoShow ? ' (no-show)' : ''}${hasNoShowFlag ? ' · flagged' : ''}${settledLabel ? ` · ${settledLabel}` : ''}`}
      aria-label={`Open booking: ${fullName}, ${service}${timeLabel ? `, ${timeLabel}` : ''}${isNoShow ? ', no-show' : ''}${flagSuffix}${settledSuffix}`}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        minHeight: peekingUnder ? 14 : MIN_PILL_HEIGHT_PX,
        left: laneBox.left,
        width: laneBox.width,
        zIndex: laneBox.zIndex,
        boxShadow: overlapShadow,
        ...(color && {
          backgroundColor: color.accent,
          color: color.text,
        }),
      }}
    >
      {peekingUnder ? null : (
      <span className="pointer-events-none absolute right-0.5 top-0.5 z-10 flex items-start gap-0.5">
        <SettlementCheckMarker payment={apt.terminal_payment} />
        {hasNoShowFlag ? (
          <span
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-amber-50/95 text-amber-800 shadow-sm"
            aria-hidden="true"
            title="Client has an active no-show flag"
          >
            <Flag className="h-2.5 w-2.5" strokeWidth={2.4} />
          </span>
        ) : null}
      </span>
      )}
      {stacked ? (
        <>
          <div className={nameClass} style={nameStyle}>
            {name}
          </div>
          {detailBits ? (
            <div className={`truncate ${mutedClass}`} style={mutedStyle}>
              {detailBits}
            </div>
          ) : null}
        </>
      ) : (
        <div
          className={`truncate ${compactLabel ? 'text-[10px] leading-none' : 'text-xs'} ${isNoShow ? 'line-through' : ''}`}
        >
          <span
            className={
              isNoShow
                ? 'font-semibold text-gray-400'
                : color
                  ? 'font-semibold'
                  : 'font-semibold text-stone-900'
            }
            style={nameStyle}
          >
            {name}
          </span>
          {detailBits ? (
            <span className={mutedClass} style={mutedStyle}>
              {` · ${detailBits}`}
            </span>
          ) : null}
        </div>
      )}
    </button>
  );
}
