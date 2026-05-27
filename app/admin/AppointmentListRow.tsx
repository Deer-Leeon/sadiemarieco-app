'use client';

import { format, parseISO } from 'date-fns';

import type { Appointment } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { getServiceColor } from './serviceColors';

const TIME_FORMAT = 'h:mm a';

export function AppointmentStatusPill({ status }: { status: string | null }) {
  const s = (status || '').toLowerCase();
  if (s === 'confirmed') {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700">
        Confirmed
      </span>
    );
  }
  if (s === 'pending') {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700">
        Awaiting Payment
      </span>
    );
  }
  if (s === 'no-show') {
    return (
      <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">
        No-show
      </span>
    );
  }
  if (s === 'canceled_by_admin') {
    return (
      <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-700">
        Cancelled by you
      </span>
    );
  }
  if (s === 'canceled_by_client_late') {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800">
        Late cancel ($20)
      </span>
    );
  }
  if (s === 'canceled_by_client' || s === 'cancelled') {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700">
        Cancelled by client
      </span>
    );
  }
  if (s === 'canceled_by_system') {
    return (
      <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500">
        Cancelled by system
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-600">
      {status || 'Unknown'}
    </span>
  );
}

function isCanceledStatus(status: string | null): boolean {
  const s = (status || '').toLowerCase();
  return (
    s === 'cancelled' ||
    s === 'canceled_by_admin' ||
    s === 'canceled_by_client' ||
    s === 'canceled_by_client_late' ||
    s === 'canceled_by_system'
  );
}

/**
 * Bookings-list row — shared by /admin list view and client appointment
 * history. Full-width service colour block, time column, status pill.
 */
export function AppointmentListRow({
  appointment,
  onSelect,
  variant = 'bookings',
}: {
  appointment: Appointment;
  /** When set, the row renders as a clickable button (client history). */
  onSelect?: () => void;
  /** `bookings` shows client name + service; `client` shows service only. */
  variant?: 'bookings' | 'client';
}) {
  const time = appointment.booking_time
    ? format(parseISO(appointment.booking_time), TIME_FORMAT)
    : '—';

  const statusLower = (appointment.status || '').toLowerCase();
  const isNoShow = statusLower === 'no-show';
  const isPending = statusLower === 'pending';
  const isCanceled = isCanceledStatus(appointment.status);
  const strike = isNoShow || (variant === 'client' && isCanceled);

  const color =
    isNoShow || isPending || (variant === 'client' && isCanceled)
      ? null
      : getServiceColor(appointment);
  const colorStyle = color
    ? { backgroundColor: color.accent, color: color.text }
    : undefined;
  const primaryColorStyle = color ? { color: color.text } : undefined;
  const mutedColorStyle = color ? { color: color.textMuted } : undefined;

  const rowClass = `grid w-full grid-cols-[80px_1fr_auto] items-center gap-4 rounded-lg border px-4 py-3 text-left transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF9F6] ${
    isPending
      ? 'border-amber-200 bg-amber-50/40 opacity-90'
      : 'border-stone-200 bg-white'
  } ${isNoShow ? 'opacity-60' : ''} ${variant === 'client' && isCanceled ? 'opacity-70' : ''}`;

  const primaryTextClass = strike
    ? 'text-gray-400 line-through'
    : color
      ? ''
      : 'text-stone-900';

  const mutedTextClass = strike
    ? 'text-gray-400 line-through'
    : color
      ? ''
      : 'text-stone-500';

  const content = (
    <>
      <span
        className={`font-serif text-base ${primaryTextClass}`}
        style={primaryColorStyle}
      >
        {time}
      </span>
      <div className="min-w-0">
        {variant === 'bookings' ? (
          <>
            <p
              className={`truncate text-sm font-medium ${primaryTextClass}`}
              style={primaryColorStyle}
            >
              {clientDisplayName(
                appointment.client_first_name,
                appointment.client_last_name
              )}
            </p>
            <p
              className={`mt-0.5 truncate text-xs ${mutedTextClass}`}
              style={mutedColorStyle}
            >
              {appointmentServiceLabel(appointment)}
            </p>
          </>
        ) : (
          <p
            className={`truncate text-sm font-medium ${primaryTextClass}`}
            style={primaryColorStyle}
          >
            {appointmentServiceLabel(appointment)}
          </p>
        )}
      </div>
      <AppointmentStatusPill status={appointment.status} />
    </>
  );

  if (onSelect) {
    return (
      <li>
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Open appointment · ${appointmentServiceLabel(appointment)}`}
          className={rowClass}
          style={colorStyle}
        >
          {content}
        </button>
      </li>
    );
  }

  return (
    <li className={rowClass} style={colorStyle}>
      {content}
    </li>
  );
}
