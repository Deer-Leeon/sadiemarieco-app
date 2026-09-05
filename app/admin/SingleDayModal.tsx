'use client';

import { useEffect, useMemo, useState } from 'react';
import { addDays, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, Flag, X } from 'lucide-react';

import {
  calendarDayUtcNoon,
  formatStudioClockRange,
  studioDateKey,
} from '@/lib/studio-calendar';

import ClosedHoursHatch from './components/ClosedHoursHatch';
import { ExtraCountBadge } from './components/ExtraCountBadge';
import { SettlementCheckMarker } from './components/SettlementMarker';
import TimeBlockPill from './components/TimeBlockPill';
import type { Appointment, TimeBlock } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { settlementAriaLabel } from './settlementDisplay';
import { getServiceColor } from './serviceColors';
import {
  HOURS,
  MIN_PILL_HEIGHT_PX,
  MODAL_HOUR_GRID_ROWS,
  START_HOUR,
  closedBandPercentsForDay,
  layoutBlocksForDay,
  layoutForDay,
  overlapLaneBoxStyle,
  safeParseISO,
  type PositionedAppointment,
  type PositionedTimeBlock,
} from './timeline';
import type {
  StudioAvailabilityBlock,
  StudioDateOverride,
} from '@/lib/studio-schedule-windows';

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

function studioHeaderParts(date: Date): { weekday: string; monthDay: string } {
  const key = studioDateKey(date);
  const d = key ? calendarDayUtcNoon(key) : date;
  const timeZone = key ? 'UTC' : undefined;
  return {
    weekday: new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
    }).format(d),
    monthDay: new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'long',
      day: 'numeric',
    }).format(d),
  };
}

interface Props {
  appointments: Appointment[];
  timeBlocks: TimeBlock[];
  initialDate: Date;
  removingBlockId?: string | null;
  onClose: () => void;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
  onHourClick?: (date: Date, hour: number) => void;
  /** When a nested book/block dialog is open, don't steal Escape. */
  ignoreEscape?: boolean;
  scheduleAvailability?: StudioAvailabilityBlock[] | null;
  scheduleOverrides?: StudioDateOverride[] | null;
}

export default function SingleDayModal({
  appointments,
  timeBlocks,
  initialDate,
  removingBlockId = null,
  onClose,
  onAppointmentClick,
  onBlockClick,
  onHourClick,
  ignoreEscape = false,
  scheduleAvailability = null,
  scheduleOverrides = null,
}: Props) {
  const [activeDate, setActiveDate] = useState<Date>(initialDate);

  useEffect(() => {
    setActiveDate(initialDate);
  }, [initialDate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (ignoreEscape) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft') {
        setActiveDate((d) => subDays(d, 1));
        return;
      }
      if (e.key === 'ArrowRight') {
        setActiveDate((d) => addDays(d, 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, ignoreEscape]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const positioned = useMemo(
    () => layoutForDay(activeDate, appointments),
    [activeDate, appointments]
  );

  const positionedBlocks = useMemo(
    () => layoutBlocksForDay(activeDate, timeBlocks),
    [activeDate, timeBlocks]
  );

  const header = studioHeaderParts(activeDate);

  const hatchBands = useMemo(
    () =>
      closedBandPercentsForDay(
        activeDate,
        positioned.map((item) => item.appointment),
        scheduleAvailability,
        scheduleOverrides
      ),
    [activeDate, positioned, scheduleAvailability, scheduleOverrides]
  );

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4 sm:p-6 backdrop-blur-sm"
        onClick={onClose}
        role="presentation"
      >
        <div
          className="flex h-[min(92vh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-[#FAF9F6] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Schedule on ${header.weekday}, ${header.monthDay}`}
        >
          <ModalHeader
            weekday={header.weekday}
            monthDay={header.monthDay}
            onPrev={() => setActiveDate((d) => subDays(d, 1))}
            onNext={() => setActiveDate((d) => addDays(d, 1))}
            onClose={onClose}
          />

          <p className="shrink-0 border-b border-stone-200 px-4 py-2.5 text-center text-[11px] uppercase tracking-[0.22em] text-stone-500">
            Click an hour to book or block · click a block to edit
          </p>

          <div className="min-h-0 flex-1 overflow-hidden px-1 pb-1 pt-1">
            <DayTimeline
              positioned={positioned}
              positionedBlocks={positionedBlocks}
              hatchBands={hatchBands}
              removingBlockId={removingBlockId}
              onHourClick={(hour) => onHourClick?.(activeDate, hour)}
              onAppointmentClick={onAppointmentClick}
              onBlockClick={onBlockClick}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function ModalHeader({
  weekday,
  monthDay,
  onPrev,
  onNext,
  onClose,
}: {
  weekday: string;
  monthDay: string;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  return (
    <div className="relative flex items-center justify-center border-b border-stone-200 bg-[#FAF9F6] px-4 py-4">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous day"
        className="absolute left-4 inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-700 transition-colors hover:bg-stone-100"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div className="text-center">
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
          {weekday}
        </p>
        <h2 className="font-serif text-2xl text-stone-900">{monthDay}</h2>
      </div>

      <div className="absolute right-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onNext}
          aria-label="Next day"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-700 transition-colors hover:bg-stone-100"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function DayTimeline({
  positioned,
  positionedBlocks,
  hatchBands,
  removingBlockId,
  onHourClick,
  onAppointmentClick,
  onBlockClick,
}: {
  positioned: PositionedAppointment[];
  positionedBlocks: PositionedTimeBlock[];
  hatchBands: { topPct: number; heightPct: number }[];
  removingBlockId: string | null;
  onHourClick: (hour: number) => void;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
}) {
  return (
    <div
      className="grid h-full min-h-0 w-full"
      style={{
        gridTemplateColumns: '72px minmax(0, 1fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      <TimeLabelColumn />
      <DayBody
        positioned={positioned}
        positionedBlocks={positionedBlocks}
        hatchBands={hatchBands}
        removingBlockId={removingBlockId}
        onHourClick={onHourClick}
        onAppointmentClick={onAppointmentClick}
        onBlockClick={onBlockClick}
      />
    </div>
  );
}

function TimeLabelColumn() {
  return (
    <div
      className="grid h-full min-h-0 border-r border-stone-200"
      style={{ gridTemplateRows: MODAL_HOUR_GRID_ROWS }}
    >
      {Array.from({ length: HOURS }, (_, i) => {
        const hour = START_HOUR + i;
        return (
          <div
            key={hour}
            className="flex items-start justify-end border-t border-stone-200 pr-3 pt-2 text-[11px] font-medium uppercase tracking-widest text-stone-400"
          >
            {HOUR_LABELS[i]}
          </div>
        );
      })}
    </div>
  );
}

function DayBody({
  positioned,
  positionedBlocks,
  hatchBands,
  removingBlockId,
  onHourClick,
  onAppointmentClick,
  onBlockClick,
}: {
  positioned: PositionedAppointment[];
  positionedBlocks: PositionedTimeBlock[];
  hatchBands: { topPct: number; heightPct: number }[];
  removingBlockId: string | null;
  onHourClick: (hour: number) => void;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
}) {
  const isEmpty = positioned.length === 0 && positionedBlocks.length === 0;

  return (
    <div className="relative h-full min-h-0">
      <ClosedHoursHatch bands={hatchBands} />
      <div
        className="pointer-events-none absolute inset-0 z-1 grid h-full"
        style={{ gridTemplateRows: MODAL_HOUR_GRID_ROWS }}
        aria-hidden="true"
      >
        {Array.from({ length: HOURS }, (_, i) => (
          <div key={i} className="border-t border-stone-200" />
        ))}
      </div>

      <div
        className="absolute inset-0 grid h-full"
        style={{ gridTemplateRows: MODAL_HOUR_GRID_ROWS }}
      >
        {Array.from({ length: HOURS }, (_, i) => {
          const hour = START_HOUR + i;
          return (
            <button
              key={hour}
              type="button"
              aria-label={`Book or block time starting at ${HOUR_LABELS[i]}`}
              className="w-full border-t border-transparent transition-colors hover:bg-stone-900/[0.04] focus:outline-none focus-visible:bg-stone-900/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-400/60"
              onClick={(e) => {
                e.stopPropagation();
                onHourClick(hour);
              }}
            />
          );
        })}
      </div>

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs uppercase tracking-[0.28em] text-stone-400">
            No bookings — click an hour to book or block
          </p>
        </div>
      )}

      {positionedBlocks.map((pb) => (
        <TimeBlockPill
          key={pb.block.id}
          block={pb.block}
          topPct={pb.topPct}
          heightPct={pb.heightPct}
          removing={removingBlockId === pb.block.id}
          spacious
          className="ml-3 w-[calc(100%-1.25rem)] rounded-md"
          onClick={onBlockClick ? () => onBlockClick(pb.block) : undefined}
        />
      ))}

      {positioned.map((pa) => (
        <ModalAppointment
          key={pa.appointment.id}
          positioned={pa}
          onClick={onAppointmentClick}
        />
      ))}
    </div>
  );
}

function ModalAppointment({
  positioned,
  onClick,
}: {
  positioned: PositionedAppointment;
  onClick?: (appointment: Appointment) => void;
}) {
  const { appointment: apt, topPct, heightPct, col, totalCols } = positioned;
  const statusLower = (apt.status || '').toLowerCase();
  const isNoShow = statusLower === 'no-show';
  const hasNoShowFlag = Boolean(apt.client_no_show_flag);

  const start = safeParseISO(apt.booking_time);
  const end = safeParseISO(apt.end_time);
  const timeLabel = start ? formatStudioClockRange(start, end) : '';

  const name = clientDisplayName(apt.client_first_name, apt.client_last_name);
  const service = appointmentServiceLabel(apt);
  const overlapping = totalCols > 1;
  const dense = overlapping;

  const laneBox = overlapLaneBoxStyle(col, totalCols, {
    outerPx: overlapping ? 2 : 8,
    gapPx: overlapping ? 2 : 0,
  });

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClick?.(apt);
  };
  const clickable = !!onClick;

  const color = isNoShow ? null : getServiceColor(apt);
  const baseClasses = dense
    ? 'absolute z-20 overflow-hidden rounded-md px-1.5 py-1.5 text-left leading-tight shadow-sm transition-colors'
    : 'absolute z-20 overflow-hidden rounded-md p-2.5 shadow-sm transition-colors text-left';
  const variantClasses = isNoShow
    ? 'border-l-[3px] border-stone-400 bg-stone-50 opacity-60'
    : color
      ? ''
      : 'border-l-[3px] border-stone-800 bg-stone-100';
  const flaggedClasses =
    hasNoShowFlag && !isNoShow ? 'ring-1 ring-inset ring-amber-400/70' : '';
  const interactiveClasses = clickable
    ? 'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-stone-900/40'
    : '';
  const settledLabel = settlementAriaLabel(apt.terminal_payment);

  return (
    <button
      type="button"
      onClick={clickable ? handleClick : undefined}
      disabled={!clickable}
      className={`${baseClasses} ${variantClasses} ${flaggedClasses} ${interactiveClasses}`}
      title={`${timeLabel}${timeLabel ? ' · ' : ''}${name} — ${service}${isNoShow ? ' (no-show)' : ''}${hasNoShowFlag ? ' · flagged' : ''}${settledLabel ? ` · ${settledLabel}` : ''}`}
      aria-label={`Open booking: ${name}, ${service}${timeLabel ? `, ${timeLabel}` : ''}${isNoShow ? ', no-show' : ''}${hasNoShowFlag ? ', no-show flag' : ''}${settledLabel ? `, ${settledLabel}` : ''}`}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        minHeight: MIN_PILL_HEIGHT_PX,
        left: laneBox.left,
        width: laneBox.width,
        zIndex: laneBox.zIndex,
        ...(color && {
          backgroundColor: color.accent,
          color: color.text,
        }),
      }}
    >
      <span className="pointer-events-none absolute right-1 top-1 z-10 flex items-start gap-0.5">
        <SettlementCheckMarker payment={apt.terminal_payment} size={dense ? 'sm' : 'md'} />
        <ExtraCountBadge count={apt.extra_count} size={dense ? 'sm' : 'md'} />
        {hasNoShowFlag ? (
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-amber-50/95 text-amber-800 shadow-sm"
            aria-hidden="true"
          >
            <Flag className="h-2.5 w-2.5" strokeWidth={2.4} />
          </span>
        ) : null}
      </span>
      <div
        className={`truncate font-medium ${
          dense ? 'text-[13px] leading-tight' : 'text-sm'
        } ${
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
        className={`mt-0.5 truncate leading-snug ${
          dense ? 'text-[10px]' : 'text-[11px]'
        } ${
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
