'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import Cal, { getCalApi, type EmbedEvent } from '@calcom/embed-react';
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  ChevronRight,
  Clock,
  DollarSign,
  ExternalLink,
  Loader2,
  Mail,
  Phone,
  Scissors,
  X,
} from 'lucide-react';

import {
  isSameAppointmentSlot,
  rescheduleSameSlotNotice,
} from '@/lib/appointment-slot';
import {
  ADMIN_CAL_UI_CONFIG,
  CAL_USERNAME,
  extractBookingDataFromEvent,
} from '@/lib/cal-embed-shared';

import type { Appointment, AppointmentStatus } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import ClientProfileModal from './ClientProfileModal';

// Cal.com embed namespace. Used both as the React component's
// `namespace` prop and as the key passed to `getCalApi({ namespace })`
// so the event listener attaches to the same iframe instance. Kept as
// a module-level constant to guarantee both call sites always agree.
const CAL_RESCHEDULE_NAMESPACE = 'reschedule';

interface Props {
  appointment: Appointment;
  onClose: () => void;
  /**
   * Set when this modal is rendered ON TOP of another modal — e.g.
   * opened from the appointment-history list inside a
   * ClientProfileModal. Two things change in that mode:
   *
   *   1. z-index bumps from z-60 to z-70 so the new shell stacks
   *      visually above the underlying one (which sits at z-60).
   *   2. ESC dispatches through a module-scope LIFO stack (see
   *      `escStack` below) so a single keystroke only dismisses
   *      the topmost modal, not every open modal in the tree.
   *
   * Body scroll lock is safe to leave unchanged: the snapshot
   * pattern stores the parent's already-locked value on mount and
   * restores it on unmount, so the outer modal's lock survives.
   */
  stacked?: boolean;
  /**
   * Fires immediately before `onClose` whenever the user actually
   * mutated the appointment from inside the modal (status PATCH:
   * no-show / cancel, OR a successful reschedule). NOT called when
   * the user just opens and closes without changes — that means
   * a parent rendering a list can skip the refetch in the
   * just-looking case.
   *
   * router.refresh() is still fired by the modal itself for every
   * mutation, so server components stay consistent regardless of
   * whether the parent uses this callback.
   */
  onMutated?: () => void;
}

/**
 * Module-scope LIFO stack of open AppointmentModal close handlers.
 * Whenever an instance mounts it pushes its `onClose`; on unmount
 * it removes itself. The keydown handler each instance registers
 * only fires for the topmost entry, so a stack of N modals
 * (e.g. dashboard → appointment → client → another appointment)
 * dismisses one ESC press at a time.
 *
 * We keep this here (rather than a Context provider) because it's
 * a cross-tree concern — a modal opened from inside another
 * modal's body has no shared React parent that could mediate.
 */
const escStack: Array<() => void> = [];

/**
 * The modal's top-level content swap. AppointmentModal owns the
 * outer shell (backdrop, card, ESC handler, scroll lock) and routes
 * between the appointment-detail body and the ClientProfileModal
 * body based on this state. We keep the routing here rather than at
 * the dashboard level because closing the modal should land back on
 * the calendar regardless of which content view was active when the
 * close happened — a single top-level `onClose` is the right shape.
 */
type ModalView = 'appointment' | 'client';

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
export default function AppointmentModal({
  appointment,
  onClose,
  stacked = false,
  onMutated,
}: Props) {
  const router = useRouter();

  // Internal "what content is rendered inside the shell" state. The
  // shell stays mounted across swaps so the backdrop / ESC handler /
  // scroll lock don't churn when the admin drills into a client
  // profile and back.
  const [view, setView] = useState<ModalView>('appointment');

  // The reschedule iframe is a heavy embed (full Cal booking flow), so
  // we keep it gated behind a separate boolean instead of cramming it
  // into ModalView. The shell still owns this state — when the embed
  // signals success (router.refresh + onClose), we drop straight out
  // of the modal rather than flashing the details view first.
  const [isRescheduling, setIsRescheduling] = useState(false);

  // Loading state for the No-show / Cancel status PATCH. We disable
  // BOTH buttons (not just the clicked one) while one request is in
  // flight — once the local DB write succeeds we router.refresh() and
  // onClose(), so a parallel second click would race the unmount.
  const [statusAction, setStatusAction] = useState<
    null | 'no-show' | 'canceled_by_admin'
  >(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const canChargeNoShow =
    Boolean(appointment.stripe_customer_id) &&
    appointment.service_price != null &&
    Number.isFinite(appointment.service_price) &&
    appointment.service_price > 0;

  const handleStatusChange = async (next: AppointmentStatus) => {
    if (statusAction !== null) return;
    if (next === 'no-show') {
      if (!canChargeNoShow) {
        setStatusError(
          'No vaulted card or service price on file — a 50% no-show fee cannot be charged.'
        );
        return;
      }
      const confirmed = window.confirm(
        "Are you sure you want to mark this as a No-Show? This will automatically charge the client's vaulted card for 50% of the service price."
      );
      if (!confirmed) return;
    }
    if (next === 'canceled_by_admin') {
      const confirmed = window.confirm(
        'Are you sure you want to cancel this appointment? The client will be notified.'
      );
      if (!confirmed) return;
    }

    setStatusAction(next === 'no-show' ? 'no-show' : 'canceled_by_admin');
    setStatusError(null);

    try {
      const res = await fetch(
        `/api/admin/appointments/${appointment.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
        cal_cancel_error?: string | null;
        no_show_charge?: {
          amount_cents?: number;
          currency?: string;
        } | null;
      } | null;

      if (!res.ok) {
        const msg =
          (data && typeof data === 'object' && data.message) ||
          (data && typeof data === 'object' && data.error) ||
          `HTTP ${res.status}`;
        const code = data && typeof data === 'object' ? data.error : undefined;
        if (
          code === 'card_declined' ||
          code === 'authentication_required' ||
          code === 'no_payment_method' ||
          code === 'no_vaulted_card'
        ) {
          alert(`Card charge failed:\n${msg}`);
        }
        throw new Error(msg);
      }
      // Non-fatal Cal cancel error: the local DB row was updated but
      // Cal didn't accept the cancellation. We surface this as a
      // warning rather than blocking the close, because the admin's
      // intent ("this is no longer on my calendar") is now reflected
      // locally. They can manually reconcile in Cal's dashboard.
      if (data?.cal_cancel_error) {
        console.warn(
          '[AppointmentModal] cal cancel warning',
          data.cal_cancel_error
        );
        // Surface to the admin via a transient alert. We deliberately
        // don't block the close — a future polish pass could swap
        // this for a toast component, but alert is the least-bad
        // option without one wired up.
        alert(
          `Saved locally, but Cal.com didn't confirm the cancellation:\n${data.cal_cancel_error}\n\nThe appointment will still disappear from your dashboard. You may want to verify the booking in Cal.com.`
        );
      }
      router.refresh();
      // Signal mutation to any list rendering this appointment so
      // it can refresh its own local copy (stale-while-revalidate).
      // Called BEFORE onClose so the parent can capture state
      // synchronously before this modal unmounts.
      onMutated?.();
      onClose();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
      setStatusAction(null);
    }
  };

  // ESC to close. Bound at window so the modal closes regardless of
  // which child element has focus when the user hits the key. While
  // the reschedule embed is open we let the user bail with ESC too —
  // it's a less destructive "abort" than the explicit Back button.
  //
  // Stacking: each instance pushes its `onClose` onto `escStack`
  // on mount, and the keydown handler only fires for the topmost
  // entry. This means a stacked modal (e.g. an appointment opened
  // from inside a ClientProfileModal's history list) eats one ESC
  // press without also dismissing the modal underneath it.
  useEffect(() => {
    escStack.push(onClose);
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (escStack[escStack.length - 1] !== onClose) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      const i = escStack.lastIndexOf(onClose);
      if (i >= 0) escStack.splice(i, 1);
      window.removeEventListener('keydown', onKey);
    };
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

  // The reschedule embed needs noticeably more width than the
  // details view — Cal's month picker + the time-slot column don't
  // breathe at `max-w-lg`. Same vertical envelope.
  const cardWidthClass = isRescheduling ? 'max-w-4xl' : 'max-w-lg';

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm ${
        stacked ? 'z-70' : 'z-60'
      }`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`flex max-h-[90vh] w-full ${cardWidthClass} flex-col overflow-hidden rounded-2xl bg-[#FAF9F6] shadow-2xl transition-[max-width] duration-200`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={
          isRescheduling
            ? 'Reschedule appointment'
            : view === 'client'
              ? 'Client profile'
              : 'Appointment details'
        }
      >
        {isRescheduling ? (
          <RescheduleView
            appointment={appointment}
            onBack={() => setIsRescheduling(false)}
            // RescheduleView only calls onClose after a successful
            // reschedule (the Back button uses onBack instead), so
            // wrapping with onMutated here is precise: it fires
            // exactly when the booking actually changed time.
            onClose={() => {
              onMutated?.();
              onClose();
            }}
          />
        ) : view === 'appointment' ? (
          <>
            <ModalHeader appointment={appointment} onClose={onClose} />

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="flex flex-col gap-4">
                <ClientBox
                  appointment={appointment}
                  onOpenProfile={() => setView('client')}
                />
                <DateTimeBox appointment={appointment} />
                <ServiceBox appointment={appointment} />
              </div>
            </div>

            <ActionFooter
              canReschedule={Boolean(appointment.service_slug)}
              canChargeNoShow={canChargeNoShow}
              onReschedule={() => setIsRescheduling(true)}
              onNoShow={() => handleStatusChange('no-show')}
              onCancel={() => handleStatusChange('canceled_by_admin')}
              statusAction={statusAction}
              statusError={statusError}
            />
          </>
        ) : (
          <ClientProfileModal
            appointment={appointment}
            backLabel="Appointment"
            onBack={() => setView('appointment')}
            onClose={onClose}
          />
        )}
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
  // The header eyebrow uses the status pill colour so a cancelled /
  // no-show booking reads as such at a glance, even before the editor
  // notices the strikethrough on the service line below.
  const status = (appointment.status || '').toLowerCase();
  const { label: statusLabel, tone } = describeHeaderStatus(status);

  return (
    <div className="relative flex items-center justify-between border-b border-stone-200 bg-[#FAF9F6] px-6 py-4">
      <div>
        <p
          className={`text-[10px] font-medium uppercase tracking-[0.28em] ${tone}`}
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

function ClientBox({
  appointment,
  onOpenProfile,
}: {
  appointment: Appointment;
  onOpenProfile: () => void;
}) {
  const name = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  );

  // The name turns into a clickable entry-point to ClientProfileModal
  // when we have a phone to identify the client by. Without a phone
  // we render the name as plain text — the CRM is phone-keyed and
  // wouldn't know which row to load (an appointment without a phone
  // is a legacy / web-form booking we never associated with a real
  // CRM record).
  const canOpenProfile = Boolean(appointment.client_phone);

  return (
    <DetailBox label="Client" icon={<Scissors className="h-3 w-3" />}>
      {canOpenProfile ? (
        <button
          type="button"
          onClick={onOpenProfile}
          className="group inline-flex items-baseline gap-1.5 text-left font-serif text-xl leading-tight text-stone-900 underline-offset-4 transition-colors hover:text-stone-600 hover:underline"
        >
          <span>{name}</span>
          <ChevronRight className="h-4 w-4 self-center text-stone-400 transition-transform group-hover:translate-x-0.5" />
        </button>
      ) : (
        <p className="font-serif text-xl leading-tight text-stone-900">
          {name}
        </p>
      )}

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
  // Use the duration-aware label so a bare "Classic" appointment
  // reads as "Classic 2 Week Fill" in the modal, matching the
  // calendar / list view the editor clicked through from. Strips
  // Cal's "between X and Y" suffix the same way.
  const title = appointmentServiceLabel(appointment);
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

function ActionFooter({
  canReschedule,
  canChargeNoShow,
  onReschedule,
  onNoShow,
  onCancel,
  statusAction,
  statusError,
}: {
  /**
   * False when the appointment has no `cal_uid` (legacy / corrupted
   * row). Cal's reschedule URL requires the booking UID, so without
   * it the button is greyed out and tooltips an explanation rather
   * than opening an empty embed.
   */
  canReschedule: boolean;
  /** False when there is no vaulted card or resolvable service price. */
  canChargeNoShow: boolean;
  onReschedule: () => void;
  onNoShow: () => void;
  onCancel: () => void;
  /**
   * Which status mutation is currently in flight, if any. Drives
   * the per-button spinner and disables BOTH buttons (so the admin
   * can't fire two PATCHes that race the router refresh + close).
   */
  statusAction: null | 'no-show' | 'canceled_by_admin';
  /**
   * Surfaced under the footer when the PATCH fails. Cleared
   * automatically on the next attempt.
   */
  statusError: string | null;
}) {
  const busy = statusAction !== null;

  return (
    <div className="border-t border-stone-200 bg-white">
      {statusError && (
        <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-xs text-rose-800">
          Couldn&rsquo;t update — {statusError}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 px-6 py-4">
        <button
          type="button"
          onClick={onReschedule}
          disabled={!canReschedule || busy}
          title={
            canReschedule
              ? undefined
              : 'Cannot reschedule — no Cal.com service link on this appointment.'
          }
          className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
        >
          Reschedule
        </button>
        <button
          type="button"
          onClick={onNoShow}
          disabled={busy || !canChargeNoShow}
          title={
            canChargeNoShow
              ? 'Charge 50% of the service price to the card on file and mark as no-show'
              : 'Requires a vaulted card and a service price from checkout'
          }
          className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white"
        >
          {statusAction === 'no-show' ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Charging
            </>
          ) : (
            'No-show'
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white"
        >
          {statusAction === 'canceled_by_admin' ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Canceling
            </>
          ) : (
            'Cancel'
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Map the row's raw status text to a header eyebrow label + colour
 * tone. Centralised so the four lifecycle states render with
 * consistent vocabulary across the modal header (here) and the
 * client-profile history badges. Unknown / legacy values render as
 * a neutral "Booking" — better than throwing on an unrecognised
 * string from the DB.
 */
function describeHeaderStatus(status: string): {
  label: string;
  tone: string;
} {
  switch (status) {
    case 'canceled_by_admin':
      return { label: 'Cancelled by you', tone: 'text-rose-700' };
    case 'canceled_by_client':
      return { label: 'Cancelled by client', tone: 'text-amber-700' };
    case 'canceled_by_client_late':
      return {
        label: 'Late cancel (fee charged)',
        tone: 'text-amber-800',
      };
    case 'no-show':
      return { label: 'No-show', tone: 'text-stone-500' };
    case 'confirmed':
    default:
      return { label: 'Booking', tone: 'text-stone-500' };
  }
}

/** Cal embed mode: true reschedule vs fresh slot on the same service. */
type RescheduleEmbedMode = 'reschedule' | 'new_slot';

type ReschedulePhase = 'embed' | 'error' | 'completing';

/**
 * Build the calLink string the same way our public manage portal does
 * (`public/js/manage.js`): put `rescheduleUid` in the URL query string,
 * not in the React `config` prop — Cal's embed reliably reads it there.
 */
function buildRescheduleCalLink(
  serviceSlug: string,
  calUid: string | null,
  mode: RescheduleEmbedMode
): string {
  const base = `${CAL_USERNAME}/${serviceSlug}`;
  if (mode === 'reschedule' && calUid) {
    return `${base}?rescheduleUid=${encodeURIComponent(calUid)}`;
  }
  return base;
}

/**
 * Embedded Cal.com reschedule flow.
 *
 * On success we POST the new slot to our backend (update in place),
 * refresh the dashboard, and close — before Cal's iframe can navigate
 * to a post-success URL that sometimes 404s inside embed mode.
 */
function RescheduleView({
  appointment,
  onBack,
  onClose,
}: {
  appointment: Appointment;
  onBack: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const serviceSlug = appointment.service_slug;

  const [embedMode, setEmbedMode] = useState<RescheduleEmbedMode>(() =>
    appointment.cal_uid ? 'reschedule' : 'new_slot'
  );
  const [phase, setPhase] = useState<ReschedulePhase>('embed');
  const [embedKey, setEmbedKey] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sameSlotNotice, setSameSlotNotice] = useState(false);

  // Cal fires multiple success events in quick succession; guard so we
  // only apply the DB update + close once.
  const completedRef = useRef(false);
  // After blocking a no-op reschedule, Cal sometimes emits linkFailed
  // while its iframe settles — ignore those for a few seconds.
  const ignoreLinkFailedRef = useRef(false);

  useEffect(() => {
    if (!serviceSlug || phase !== 'embed') return;

    let cancelled = false;
    type CalApi = Awaited<ReturnType<typeof getCalApi>>;
    let api: CalApi | null = null;

    const persistReschedule = async (event: unknown): Promise<boolean> => {
      const newData = extractBookingDataFromEvent(event);
      if (!newData.uid || !newData.startTime) return false;

      if (
        isSameAppointmentSlot(
          appointment.booking_time,
          appointment.end_time,
          newData.startTime,
          newData.endTime
        )
      ) {
        return false;
      }

      const res = await fetch(
        `/api/admin/appointments/${appointment.id}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            newCalUid: newData.uid,
            newBookingTime: newData.startTime,
            newEndTime: newData.endTime ?? null,
            oldCalUid: appointment.cal_uid,
          }),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn('[AppointmentModal] reschedule persist failed', {
          status: res.status,
          body: text,
        });
        return false;
      }
      return true;
    };

    const handleSuccess = async (event: unknown) => {
      if (completedRef.current) return;

      const newData = extractBookingDataFromEvent(event);
      if (
        newData.startTime &&
        isSameAppointmentSlot(
          appointment.booking_time,
          appointment.end_time,
          newData.startTime,
          newData.endTime
        )
      ) {
        ignoreLinkFailedRef.current = true;
        window.setTimeout(() => {
          ignoreLinkFailedRef.current = false;
        }, 4000);
        setSameSlotNotice(true);
        setPhase('embed');
        return;
      }

      completedRef.current = true;
      setPhase('completing');
      setErrorMessage(null);
      setSameSlotNotice(false);

      const saved = await persistReschedule(event);
      if (!saved) {
        completedRef.current = false;
        setPhase('embed');
        setSameSlotNotice(true);
        return;
      }

      router.refresh();
      onClose();
    };

    const handleLinkFailed = (e: EmbedEvent<'linkFailed'>) => {
      if (cancelled || completedRef.current || ignoreLinkFailedRef.current) {
        return;
      }
      const code = e.detail?.data?.code ?? 'unknown';
      if (embedMode === 'reschedule') {
        setErrorMessage(
          "Cal.com couldn't find this booking — it may have already been moved or cancelled in Cal. You can pick a new time below and we'll update this appointment on your calendar."
        );
      } else {
        setErrorMessage(
          `Cal.com couldn't load the booking page (error ${code}). Try opening Cal.com directly, or go back and try again.`
        );
      }
      setPhase('error');
    };

    (async () => {
      try {
        const resolved = await getCalApi({
          namespace: CAL_RESCHEDULE_NAMESPACE,
        });
        if (cancelled) return;
        api = resolved;
        // Brand the iframe BEFORE Cal paints — `ui` is idempotent
        // (Cal applies the latest config to any current + future
        // iframes in this namespace). Without this, the embed
        // renders Cal's dark default theme and clashes badly with
        // our cream/stone modal surface.
        try {
          api('ui', ADMIN_CAL_UI_CONFIG);
        } catch (uiErr) {
          console.warn('[AppointmentModal] cal ui config failed', uiErr);
        }
        api('on', {
          action: 'rescheduleBookingSuccessful',
          callback: handleSuccess,
        });
        api('on', {
          action: 'rescheduleBookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('on', {
          action: 'bookingSuccessful',
          callback: handleSuccess,
        });
        api('on', {
          action: 'bookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('on', { action: 'linkFailed', callback: handleLinkFailed });
      } catch (err) {
        console.error('[AppointmentModal] failed to attach Cal listener', err);
      }
    })();

    return () => {
      cancelled = true;
      if (!api) return;
      try {
        api('off', {
          action: 'rescheduleBookingSuccessful',
          callback: handleSuccess,
        });
        api('off', {
          action: 'rescheduleBookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('off', { action: 'bookingSuccessful', callback: handleSuccess });
        api('off', {
          action: 'bookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('off', { action: 'linkFailed', callback: handleLinkFailed });
      } catch (err) {
        console.error('[AppointmentModal] failed to detach Cal listener', err);
      }
    };
  }, [
    router,
    onClose,
    appointment.id,
    appointment.cal_uid,
    serviceSlug,
    embedMode,
    phase,
    embedKey,
  ]);

  const retryAsNewSlot = () => {
    completedRef.current = false;
    ignoreLinkFailedRef.current = false;
    setEmbedMode('new_slot');
    setErrorMessage(null);
    setSameSlotNotice(false);
    setPhase('embed');
    setEmbedKey((k) => k + 1);
  };

  const retryReschedule = () => {
    completedRef.current = false;
    ignoreLinkFailedRef.current = false;
    setEmbedMode('reschedule');
    setErrorMessage(null);
    setSameSlotNotice(false);
    setPhase('embed');
    setEmbedKey((k) => k + 1);
  };

  const currentSlotLabel = (() => {
    if (!appointment.booking_time) return 'this time';
    try {
      return format(parseISO(appointment.booking_time), 'EEEE, MMMM d · h:mm a');
    } catch {
      return 'this time';
    }
  })();

  const sameSlotCopy = rescheduleSameSlotNotice(currentSlotLabel);

  const calLink =
    serviceSlug != null
      ? buildRescheduleCalLink(serviceSlug, appointment.cal_uid, embedMode)
      : null;

  const calOpenUrl = appointment.cal_uid
    ? `https://cal.com/reschedule/${encodeURIComponent(appointment.cal_uid)}`
    : serviceSlug != null
      ? `https://cal.com/${CAL_USERNAME}/${serviceSlug}`
      : null;

  return (
    <>
      <div className="flex items-center justify-between border-b border-stone-200 bg-[#FAF9F6] px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          disabled={phase === 'completing'}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
            Reschedule
          </p>
          <h2 className="font-serif text-xl text-stone-900">
            {embedMode === 'new_slot' ? 'Pick a new time' : 'Move appointment'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={phase === 'completing'}
          aria-label="Close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#FAF9F6]">
        {phase === 'completing' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#FAF9F6]/95 px-6 text-center">
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800" />
            <p className="font-serif text-lg text-stone-900">
              Updating your calendar…
            </p>
            <p className="mt-1 text-sm text-stone-500">
              Saving the new time to your dashboard.
            </p>
          </div>
        )}

        {phase === 'error' && errorMessage && (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
              <AlertCircle className="h-6 w-6" />
            </div>
            <p className="max-w-md text-sm leading-relaxed text-stone-700">
              {errorMessage}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {embedMode === 'reschedule' && (
                <button
                  type="button"
                  onClick={retryAsNewSlot}
                  className="rounded-full border border-stone-900 bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-50 transition-colors hover:bg-stone-800"
                >
                  Pick a new time
                </button>
              )}
              {embedMode === 'new_slot' && appointment.cal_uid && (
                <button
                  type="button"
                  onClick={retryReschedule}
                  className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100"
                >
                  Try reschedule link
                </button>
              )}
              {calOpenUrl && (
                <a
                  href={calOpenUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100"
                >
                  Open in Cal.com
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <button
                type="button"
                onClick={onBack}
                className="rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-500 transition-colors hover:text-stone-800"
              >
                Back to details
              </button>
            </div>
          </div>
        )}

        {phase === 'embed' && calLink && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6">
            {!sameSlotNotice && (
              <p className="mb-3 text-center text-xs leading-relaxed text-stone-500">
                Pick a new date or time below — your current booking stays
                until you confirm a different slot.
              </p>
            )}
            <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
              <Cal
                key={embedKey}
                namespace={CAL_RESCHEDULE_NAMESPACE}
                calLink={calLink}
                style={{
                  width: '100%',
                  height: '100%',
                  overflow: 'scroll',
                }}
                config={{ layout: 'month_view', theme: 'light' }}
              />
              {sameSlotNotice && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#FAF9F6]/90 p-6 backdrop-blur-[2px]">
                  <div className="max-w-sm rounded-2xl border border-stone-200 bg-white px-6 py-7 text-center shadow-sm">
                    <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-stone-100 text-stone-600">
                      <Calendar className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <h3 className="font-serif text-lg text-stone-900">
                      {sameSlotCopy.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-stone-600">
                      {sameSlotCopy.body}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setSameSlotNotice(false);
                        retryReschedule();
                      }}
                      className="mt-6 w-full rounded-full border border-stone-900 bg-stone-900 px-4 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-stone-50 transition-colors hover:bg-stone-800"
                    >
                      Choose another time
                    </button>
                    <button
                      type="button"
                      onClick={() => setSameSlotNotice(false)}
                      className="mt-3 w-full text-xs font-medium uppercase tracking-[0.16em] text-stone-500 transition-colors hover:text-stone-800"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === 'embed' && !calLink && (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="max-w-sm text-sm text-stone-500">
              This booking is missing a Cal.com service link and can&apos;t be
              rescheduled from the dashboard.
            </p>
          </div>
        )}
      </div>
    </>
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

