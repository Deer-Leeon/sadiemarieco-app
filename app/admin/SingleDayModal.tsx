'use client';

import { useEffect, useMemo, useState } from 'react';
import { addDays, format, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

import BlockTimeDialog from './BlockTimeDialog';
import TimeBlockPill from './components/TimeBlockPill';
import type { Appointment, TimeBlock } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { getServiceColor } from './serviceColors';
import {
  HOURS,
  MIN_PILL_HEIGHT_PX,
  MODAL_HOUR_GRID_ROWS,
  START_HOUR,
  layoutBlocksForDay,
  layoutForDay,
  safeParseISO,
  type PositionedAppointment,
  type PositionedTimeBlock,
} from './timeline';

interface Props {
  appointments: Appointment[];
  timeBlocks: TimeBlock[];
  initialDate: Date;
  removingBlockId?: string | null;
  onClose: () => void;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
  onBlocksChanged?: (infoMessage?: string) => void;
}

export default function SingleDayModal({
  appointments,
  timeBlocks,
  initialDate,
  removingBlockId = null,
  onClose,
  onAppointmentClick,
  onBlockClick,
  onBlocksChanged,
}: Props) {
  const [activeDate, setActiveDate] = useState<Date>(initialDate);
  const [blockDialogHour, setBlockDialogHour] = useState<number | null>(null);

  useEffect(() => {
    setActiveDate(initialDate);
  }, [initialDate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (blockDialogHour !== null) {
          setBlockDialogHour(null);
          return;
        }
        onClose();
        return;
      }
      if (blockDialogHour !== null) return;
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
  }, [onClose, blockDialogHour]);

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
          aria-label={`Schedule on ${format(activeDate, 'EEEE, MMMM d')}`}
        >
          <ModalHeader
            activeDate={activeDate}
            onPrev={() => setActiveDate((d) => subDays(d, 1))}
            onNext={() => setActiveDate((d) => addDays(d, 1))}
            onClose={onClose}
          />

          <p className="shrink-0 border-b border-stone-200 px-4 py-2.5 text-center text-[11px] uppercase tracking-[0.22em] text-stone-500">
            Click an hour to block time
          </p>

          <div className="min-h-0 flex-1 overflow-hidden px-1 pb-1 pt-1">
            <DayTimeline
              positioned={positioned}
              positionedBlocks={positionedBlocks}
              removingBlockId={removingBlockId}
              onHourClick={(hour) => setBlockDialogHour(hour)}
              onAppointmentClick={onAppointmentClick}
              onBlockClick={onBlockClick}
            />
          </div>
        </div>
      </div>

      {blockDialogHour !== null && (
        <BlockTimeDialog
          activeDate={activeDate}
          initialHour={blockDialogHour}
          onClose={() => setBlockDialogHour(null)}
          onCreated={(infoMessage) => onBlocksChanged?.(infoMessage)}
        />
      )}
    </>
  );
}

function ModalHeader({
  activeDate,
  onPrev,
  onNext,
  onClose,
}: {
  activeDate: Date;
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
          {format(activeDate, 'EEEE')}
        </p>
        <h2 className="font-serif text-2xl text-stone-900">
          {format(activeDate, 'MMMM d')}
        </h2>
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
  removingBlockId,
  onHourClick,
  onAppointmentClick,
  onBlockClick,
}: {
  positioned: PositionedAppointment[];
  positionedBlocks: PositionedTimeBlock[];
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
        const labelDate = new Date();
        labelDate.setHours(hour, 0, 0, 0);
        return (
          <div
            key={hour}
            className="flex items-start justify-end border-t border-stone-200 pr-3 pt-2 text-[11px] font-medium uppercase tracking-widest text-stone-400"
          >
            {format(labelDate, 'h a')}
          </div>
        );
      })}
    </div>
  );
}

function DayBody({
  positioned,
  positionedBlocks,
  removingBlockId,
  onHourClick,
  onAppointmentClick,
  onBlockClick,
}: {
  positioned: PositionedAppointment[];
  positionedBlocks: PositionedTimeBlock[];
  removingBlockId: string | null;
  onHourClick: (hour: number) => void;
  onAppointmentClick?: (appointment: Appointment) => void;
  onBlockClick?: (block: TimeBlock) => void;
}) {
  const isEmpty = positioned.length === 0 && positionedBlocks.length === 0;

  return (
    <div className="relative h-full min-h-0">
      <div
        className="pointer-events-none absolute inset-0 grid h-full"
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
          const labelDate = new Date();
          labelDate.setHours(hour, 0, 0, 0);
          return (
            <button
              key={hour}
              type="button"
              aria-label={`Block time starting at ${format(labelDate, 'h a')}`}
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
            No bookings — click an hour to block
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

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClick?.(apt);
  };
  const clickable = !!onClick;

  const color = isNoShow ? null : getServiceColor(apt);
  const baseClasses =
    'absolute z-20 overflow-hidden rounded-md p-2.5 shadow-sm transition-colors text-left';
  const variantClasses = isNoShow
    ? 'border-l-[3px] border-stone-400 bg-stone-50 opacity-60'
    : color
      ? ''
      : 'border-l-[3px] border-stone-800 bg-stone-100';
  const interactiveClasses = clickable
    ? 'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-stone-900/40'
    : '';

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
        left: `calc(${leftPct}% + 0.5rem)`,
        width: `calc(${widthPct}% - 1rem)`,
        ...(color && {
          backgroundColor: color.accent,
          color: color.text,
        }),
      }}
    >
      <div
        className={`truncate text-sm font-medium ${
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
        className={`mt-0.5 truncate text-[11px] ${
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
