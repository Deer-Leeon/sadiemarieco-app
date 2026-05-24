'use client';

import { useEffect, useMemo, useState } from 'react';
import { addDays, format, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

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

interface Props {
  appointments: Appointment[];
  initialDate: Date;
  onClose: () => void;
  /**
   * Fired when the user clicks an appointment pill inside the day
   * timeline. The parent renders AppointmentModal on top of this
   * modal (z-[60] above the day modal's z-50) rather than dismissing
   * the day view — so the editor keeps the day's context in place
   * while drilling into a single booking.
   */
  onAppointmentClick?: (appointment: Appointment) => void;
}

/**
 * Centered single-day timeline modal.
 *
 * Behaviour contract:
 *   - Press ESC anywhere → close.
 *   - Click the dimmed backdrop → close.
 *   - Click inside the card → do nothing (event.stopPropagation).
 *   - Prev/Next arrows shift `activeDate` by ±1 day; the modal stays
 *     open. The parent does NOT re-render this component on date
 *     changes — activeDate is owned here so users can scrub through
 *     multiple days without the parent caring.
 *   - Backdrop is `fixed inset-0 z-50` so it overlays the dashboard
 *     header & content regardless of where the component is mounted.
 */
export default function SingleDayModal({
  appointments,
  initialDate,
  onClose,
  onAppointmentClick,
}: Props) {
  const [activeDate, setActiveDate] = useState<Date>(initialDate);

  // Re-anchor activeDate if the parent picks a different initialDate
  // while the modal is mounted (e.g. user clicks a different day in
  // TimeGrid while the modal is technically still in the DOM). Without
  // this, the modal could "stick" to a stale date.
  useEffect(() => {
    setActiveDate(initialDate);
  }, [initialDate]);

  // ── Keyboard: ESC closes, ← / → navigate days ────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
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
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Body scroll lock while the modal is open ─────────────────────
  // Prevents the page underneath from scrolling when the modal's body
  // hits the end of its own scroll region.
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Bookings on ${format(activeDate, 'EEEE, MMMM d')}`}
      >
        <ModalHeader
          activeDate={activeDate}
          onPrev={() => setActiveDate((d) => subDays(d, 1))}
          onNext={() => setActiveDate((d) => addDays(d, 1))}
          onClose={onClose}
        />

        {/* Timeline body fills the remaining space inside the modal card.
            `min-h-0` lets it shrink properly inside the flex column so the
            whole 9 AM → 9 PM range always fits without internal scroll. */}
        <div className="flex min-h-0 flex-1">
          <DayTimeline
            positioned={positioned}
            onAppointmentClick={onAppointmentClick}
          />
        </div>
      </div>
    </div>
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
      {/* Left arrow — absolute so the centered title stays optically centered. */}
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
  onAppointmentClick,
}: {
  positioned: PositionedAppointment[];
  onAppointmentClick?: (appointment: Appointment) => void;
}) {
  // Same column structure as TimeGrid: a left time-labels column and a
  // single relative column for the day's content. The grid fills its
  // parent's height (the modal body), and hour rows distribute evenly
  // via the children's own grid-template-rows.
  return (
    <div
      className="grid w-full"
      style={{
        gridTemplateColumns: '60px minmax(0, 1fr)',
        // Single implicit row → force it to fill the flex parent's
        // height so the inner `repeat(HOURS, 1fr)` rows have something
        // real to scale into. See TimeGrid for the same reasoning.
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      <TimeLabelColumn />
      <DayBody
        positioned={positioned}
        onAppointmentClick={onAppointmentClick}
      />
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

function DayBody({
  positioned,
  onAppointmentClick,
}: {
  positioned: PositionedAppointment[];
  onAppointmentClick?: (appointment: Appointment) => void;
}) {
  return (
    <div className="relative">
      {/* Background hour gridlines — fill the column via `inset-0` + a
          1fr-row grid so they always match the time-labels column. */}
      <div
        className="pointer-events-none absolute inset-0 grid"
        style={{ gridTemplateRows: `repeat(${HOURS}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: HOURS }, (_, i) => (
          <div key={i} className="border-t border-stone-200" />
        ))}
      </div>
      {/* Empty-state placeholder centred over the timeline */}
      {positioned.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs uppercase tracking-[0.28em] text-stone-400">
            No bookings on this day
          </p>
        </div>
      )}
      {/* Absolute-positioned pills overlay the gridlines */}
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
  // Canceled rows are filtered out at DashboardUI before reaching
  // this modal, so the only special-case left here is no-show: render
  // it as a struck-through, greyed-out pill so the wasted slot is
  // visible without looking actionable.
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

  // Single-pill case (no overlap): renders exactly per the spec —
  //   absolute w-[calc(100%-1rem)] ml-2
  // Overlapping case: splits the available width between lanes while
  // preserving the 8px (ml-2 = 0.5rem) outer margin so the visual
  // language stays consistent with the simple case.
  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;

  // stopPropagation guards against the modal's outer
  // backdrop-click-to-close handler firing when a pill is clicked.
  // The pill itself opens AppointmentModal on top of this modal.
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClick?.(apt);
  };
  const clickable = !!onClick;

  // Same colour-coding contract as TimeGrid / ListView — accent
  // border + faint tint for active bookings, untouched neutral grey
  // for no-shows so the strike-through still reads as "wasted slot".
  const color = isNoShow ? null : getServiceColor(apt);
  const baseClasses =
    'absolute overflow-hidden rounded-sm border-l-[3px] p-2 shadow-sm transition-colors text-left';
  const variantClasses = isNoShow
    ? 'border-stone-400 bg-stone-50 opacity-60'
    : color
      ? ''
      : 'border-stone-800 bg-stone-100';
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
          borderLeftColor: color.accent,
          backgroundColor: color.tint,
        }),
      }}
    >
      <div
        className={`truncate text-sm font-medium ${
          isNoShow ? 'text-gray-400 line-through' : 'text-stone-900'
        }`}
      >
        {name}
      </div>
      <div
        className={`mt-0.5 truncate text-[11px] ${
          isNoShow ? 'text-gray-400 line-through' : 'text-stone-500'
        }`}
      >
        {timeLabel}
        {timeLabel && service ? ' · ' : ''}
        {service}
      </div>
    </button>
  );
}
