'use client';

import { useEffect } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Calendar,
  Clock,
  DollarSign,
  Mail,
  Phone,
  Scissors,
  X,
} from 'lucide-react';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';

interface Props {
  appointment: Appointment;
  onClose: () => void;
}

/**
 * AppointmentModal
 *
 * Detail overlay for a single booking. Opens above the dashboard (and
 * above SingleDayModal when stacked) at z-[60] so it always wins
 * stacking-context fights with anything else on screen.
 *
 * Layout:
 *   - Fixed-position backdrop, clickable-to-close (matches the rest of
 *     the admin modal vocabulary).
 *   - Card container: rounded, cream surface, generous padding,
 *     scrollable interior if the boxes ever exceed viewport height
 *     (long descriptions on small phones).
 *   - Three stacked information boxes (Client / Date & Time / Service)
 *     separated by `gap-4`. Each box renders as its own card so the
 *     modal reads as a "details sheet" rather than a single block.
 *   - Action footer with three placeholder buttons (Reschedule /
 *     No-show / Cancel) — wired to a placeholder alert per spec until
 *     the corresponding endpoints land.
 *
 * Accessibility:
 *   - `role="dialog"` + `aria-modal="true"` on the card,
 *   - `aria-label` describing the booking,
 *   - ESC closes (parented at window so it works regardless of focus),
 *   - Body scroll is locked while open so the page underneath can't
 *     scroll past the backdrop.
 *
 * Note on stacked modals: when AppointmentModal opens from within
 * SingleDayModal, both want to lock body overflow. We restore the
 * previously-observed value on unmount, so the outer modal's lock is
 * re-applied correctly when this one closes.
 */
export default function AppointmentModal({ appointment, onClose }: Props) {
  // ESC to close. Bound at window so the modal closes regardless of
  // which child element has focus when the user hits the key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Body scroll lock + restore. Snapshotting `previous` rather than
  // hard-coding '' on cleanup means we cooperate with any parent
  // modal that already locked overflow — when we close, the outer
  // lock survives instead of getting clobbered to "auto".
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Appointment details"
      >
        <ModalHeader appointment={appointment} onClose={onClose} />

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex flex-col gap-4">
            <ClientBox appointment={appointment} />
            <DateTimeBox appointment={appointment} />
            <ServiceBox appointment={appointment} />
          </div>
        </div>

        <ActionFooter />
      </div>
    </div>
  );
}

// ─── SUBCOMPONENTS ─────────────────────────────────────────────────────────

function ModalHeader({
  appointment,
  onClose,
}: {
  appointment: Appointment;
  onClose: () => void;
}) {
  // The header eyebrow uses the status pill colour so a cancelled
  // booking reads as cancelled at a glance even before the editor
  // notices the strikethrough on the service line below.
  const status = (appointment.status || '').toLowerCase();
  const statusLabel = status === 'cancelled' ? 'Cancelled booking' : 'Booking';

  return (
    <div className="relative flex items-center justify-between border-b border-stone-200 bg-[#FAF9F6] px-6 py-4">
      <div>
        <p
          className={`text-[10px] font-medium uppercase tracking-[0.28em] ${
            status === 'cancelled' ? 'text-amber-700' : 'text-stone-500'
          }`}
        >
          {statusLabel}
        </p>
        <h2 className="font-serif text-2xl text-stone-900">Appointment</h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Wrapper for each detail box. Uses the exact spec the user called
 * out: `p-4 border border-stone-200 rounded-lg bg-white`. The
 * heading row sits inside the box so each card is self-contained
 * (label-on-top-then-content), which keeps the modal scanable when
 * the descriptions get long.
 */
function DetailBox({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function ClientBox({ appointment }: { appointment: Appointment }) {
  const name = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  );

  return (
    <DetailBox label="Client" icon={<Scissors className="h-3 w-3" />}>
      <p className="font-serif text-xl leading-tight text-stone-900">{name}</p>

      <div className="mt-3 space-y-1.5 text-sm">
        {/*
          Phone is shown whenever we have it. Wrapped in a tel: link
          so a click in a desktop browser opens the OS handler (e.g.
          FaceTime / Skype) and on mobile dials directly. Quietly
          hidden when null so the box shrinks rather than rendering
          an empty row.
        */}
        {appointment.client_phone && (
          <a
            href={`tel:${appointment.client_phone}`}
            className="flex items-center gap-2 text-stone-700 transition-colors hover:text-stone-900"
          >
            <Phone className="h-3.5 w-3.5 text-stone-400" />
            <span className="font-mono text-[13px]">
              {appointment.client_phone}
            </span>
          </a>
        )}

        {/*
          Email is conditional per spec — when the booking came through
          without one (Cal allows email-optional on org accounts, and
          legacy rows from before we required phone don't have one
          either), we omit the row entirely so the box naturally
          shrinks rather than showing an empty label.
        */}
        {appointment.client_email && (
          <a
            href={`mailto:${appointment.client_email}`}
            className="flex items-center gap-2 text-stone-700 transition-colors hover:text-stone-900"
          >
            <Mail className="h-3.5 w-3.5 text-stone-400" />
            <span className="text-[13px]">{appointment.client_email}</span>
          </a>
        )}

        {!appointment.client_phone && !appointment.client_email && (
          <p className="text-xs italic text-stone-400">
            No contact details on file.
          </p>
        )}
      </div>
    </DetailBox>
  );
}

function DateTimeBox({ appointment }: { appointment: Appointment }) {
  const start = appointment.booking_time
    ? parseISO(appointment.booking_time)
    : null;
  const end = appointment.end_time ? parseISO(appointment.end_time) : null;

  // Three possible shapes:
  //   • full range  → "Monday, May 25, 2026 • 8:00 AM – 9:30 AM"
  //   • start only  → "Monday, May 25, 2026 • 8:00 AM"
  //   • no times    → "Time not scheduled" (legacy rows, shouldn't
  //                   normally happen in our flow but defensive)
  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());

  return (
    <DetailBox label="Date & Time" icon={<Calendar className="h-3 w-3" />}>
      {hasStart ? (
        <>
          <p className="font-serif text-lg leading-tight text-stone-900">
            {format(start!, 'EEEE, MMMM d, yyyy')}
          </p>
          <p className="mt-2 flex items-center gap-2 text-sm text-stone-700">
            <Clock className="h-3.5 w-3.5 text-stone-400" />
            {hasEnd
              ? `${format(start!, 'h:mm a')} – ${format(end!, 'h:mm a')}`
              : format(start!, 'h:mm a')}
          </p>
        </>
      ) : (
        <p className="text-sm italic text-stone-400">Time not scheduled.</p>
      )}
    </DetailBox>
  );
}

function ServiceBox({ appointment }: { appointment: Appointment }) {
  // The cleaned name is what the rest of the dashboard already shows
  // — `cleanServiceName` strips Cal's "between X and Y" suffix. We
  // reuse it here so the modal reads consistently with the timeline
  // pills the editor clicked through from.
  const title = cleanServiceName(appointment.service_name);
  const description = appointment.service_description;
  const price = appointment.service_price;

  return (
    <DetailBox label="Service" icon={<Scissors className="h-3 w-3" />}>
      {/*
        Service header laid out like the public homepage's
        .service-header: name + (optional) description on the left,
        price stacked on the right. Mirrors the wording / spacing the
        editor sees on the live site so the modal acts as a "preview
        of what the client booked" rather than a separate vocabulary.
      */}
      <div className="grid grid-cols-[1fr_auto] items-start gap-3">
        <div className="min-w-0">
          <p className="font-serif text-lg leading-tight text-stone-900">
            {title}
          </p>
          {description && (
            <p className="mt-2 line-clamp-4 text-sm italic leading-relaxed text-stone-500">
              {description}
            </p>
          )}
        </div>
        {/*
          Price hidden when null. Matches the public site's "$165" /
          "$12.50" style (whole dollars when integer, two-decimal
          otherwise). DollarSign icon + the number share the same
          font weight so they read as one unit at a glance.
        */}
        {price !== null && (
          <p className="inline-flex items-center gap-0.5 font-serif text-lg text-stone-900">
            <DollarSign className="h-4 w-4 text-stone-400" />
            {formatPrice(price)}
          </p>
        )}
      </div>
    </DetailBox>
  );
}

function ActionFooter() {
  // Placeholder behaviour per spec. Each callback gets its own
  // function so the eventual swap to real endpoints can replace
  // them one at a time without touching the layout.
  const onReschedule = () => alert('Functionality coming soon');
  const onNoShow = () => alert('Functionality coming soon');
  const onCancel = () => alert('Functionality coming soon');

  return (
    <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-white px-6 py-4">
      <button
        type="button"
        onClick={onReschedule}
        className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100"
      >
        Reschedule
      </button>
      <button
        type="button"
        onClick={onNoShow}
        className="rounded-full border border-amber-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-700 transition-colors hover:bg-amber-50"
      >
        No-show
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-full border border-rose-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-rose-700 transition-colors hover:bg-rose-50"
      >
        Cancel
      </button>
    </div>
  );
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Format a numeric price the same way the public homepage does — a
 * bare integer for whole-dollar amounts, two decimal places when the
 * studio enters cents. Keeps the modal feeling like an extension of
 * the customer-facing menu rather than its own visual dialect.
 */
function formatPrice(price: number): string {
  if (Number.isInteger(price)) return String(price);
  return price.toFixed(2);
}
