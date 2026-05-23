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
  Mail,
  Phone,
  Scissors,
  X,
} from 'lucide-react';

import type { Appointment } from './types';
import { cleanServiceName, clientDisplayName } from './helpers';
import ClientProfileModal from './ClientProfileModal';

// Cal.com embed namespace. Used both as the React component's
// `namespace` prop and as the key passed to `getCalApi({ namespace })`
// so the event listener attaches to the same iframe instance. Kept as
// a module-level constant to guarantee both call sites always agree.
const CAL_RESCHEDULE_NAMESPACE = 'reschedule';

/**
 * Cal.com account handle. MUST stay in sync with the homonymous
 * constant in `app/route.ts` (the public site uses the same value to
 * build `data-cal-link` attributes for the services menu). If the
 * studio migrates Cal accounts again, both files need updating.
 *
 * Why we don't share via import: `app/route.ts` is a Node-runtime
 * route handler and this file is a client component — pulling the
 * constant through a shared module isn't free here (would need a
 * dedicated lib file just for one string), so we accept the small
 * duplication and lean on the cross-reference comment.
 */
const CAL_USERNAME = 'mckenna-sadiemarie';

interface Props {
  appointment: Appointment;
  onClose: () => void;
}

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
export default function AppointmentModal({ appointment, onClose }: Props) {
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

  // ESC to close. Bound at window so the modal closes regardless of
  // which child element has focus when the user hits the key. While
  // the reschedule embed is open we let the user bail with ESC too —
  // it's a less destructive "abort" than the explicit Back button.
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

  // The reschedule embed needs noticeably more width than the
  // details view — Cal's month picker + the time-slot column don't
  // breathe at `max-w-lg`. Same vertical envelope.
  const cardWidthClass = isRescheduling ? 'max-w-4xl' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
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
            onClose={onClose}
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
              onReschedule={() => setIsRescheduling(true)}
            />
          </>
        ) : (
          <ClientProfileModal
            appointment={appointment}
            onBackToAppointment={() => setView('appointment')}
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

function ActionFooter({
  canReschedule,
  onReschedule,
}: {
  /**
   * False when the appointment has no `cal_uid` (legacy / corrupted
   * row). Cal's reschedule URL requires the booking UID, so without
   * it the button is greyed out and tooltips an explanation rather
   * than opening an empty embed.
   */
  canReschedule: boolean;
  onReschedule: () => void;
}) {
  // No-show / Cancel are still placeholders pending their own
  // endpoints. Keeping them visible (not commented out) so the
  // footer reads as a finished action surface — these light up in a
  // later pass without touching the Reschedule wiring.
  const onNoShow = () => alert('Functionality coming soon');
  const onCancel = () => alert('Functionality coming soon');

  return (
    <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-white px-6 py-4">
      <button
        type="button"
        onClick={onReschedule}
        disabled={!canReschedule}
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

/** Cal embed mode: true reschedule vs fresh slot on the same service. */
type RescheduleEmbedMode = 'reschedule' | 'new_slot';

type ReschedulePhase = 'embed' | 'error' | 'completing';

/**
 * Cal embed UI theme tuned for the admin's cream/stone palette.
 *
 * Mirrors the structure of `window.calUiConfig` in `public/index.html`
 * (the public site's Cal embed branding) so the reschedule iframe
 * looks like it belongs inside our app instead of dropping a stark
 * dark Cal panel into the middle of the modal.
 *
 * Variable glossary (Cal's docs are sparse — these are what actually
 * paint the booker UI):
 *   • cal-brand*           accent + primary button background
 *   • cal-bg*              page / surface backgrounds
 *   • cal-border*          card outlines and dividers
 *   • cal-text*            type colours
 *
 * `cal-bg` is intentionally transparent so the embed inherits our
 * modal's cream surface; everything else uses subtle alpha-on-stone
 * values so disabled days, hover states, and selection chips read
 * the same density as the rest of the dashboard's neutral palette.
 */
const ADMIN_CAL_UI_CONFIG = {
  theme: 'light' as const,
  styles: { branding: { brandColor: '#292524' /* stone-800 */ } },
  hideEventTypeDetails: false,
  layout: 'month_view' as const,
  cssVarsPerTheme: {
    light: {
      'cal-brand': '#1c1917', // stone-900
      'cal-brand-emphasis': '#292524', // stone-800
      'cal-brand-text': '#FAF9F6', // cream
      'cal-brand-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-brand-accent': '#44403c', // stone-700

      'cal-bg': 'transparent',
      'cal-bg-emphasis': 'rgba(28, 25, 23, 0.08)',
      'cal-bg-muted': 'rgba(28, 25, 23, 0.04)',
      'cal-bg-subtle': 'rgba(28, 25, 23, 0.03)',
      'cal-bg-inverted': '#1c1917',
      'cal-bg-info': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-success': 'rgba(28, 25, 23, 0.06)',
      'cal-bg-attention': 'rgba(180, 83, 9, 0.08)',
      'cal-bg-error': 'rgba(159, 18, 57, 0.08)',
      'cal-bg-dark-error': 'rgba(159, 18, 57, 0.18)',

      'cal-border': 'rgba(28, 25, 23, 0.16)',
      'cal-border-emphasis': 'rgba(28, 25, 23, 0.42)',
      'cal-border-subtle': 'rgba(28, 25, 23, 0.08)',
      'cal-border-booker': 'transparent',
      'cal-border-error': 'rgba(159, 18, 57, 0.32)',

      'cal-text': '#1c1917', // stone-900
      'cal-text-emphasis': '#0c0a09', // stone-950
      'cal-text-subtle': '#57534e', // stone-600
      'cal-text-muted': '#78716c', // stone-500
      'cal-text-inverted': '#FAF9F6',
      'cal-text-error': '#9f1239',
    },
  },
};

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

  // Cal fires multiple success events in quick succession; guard so we
  // only apply the DB update + close once.
  const completedRef = useRef(false);

  useEffect(() => {
    if (!serviceSlug || phase !== 'embed') return;

    let cancelled = false;
    type CalApi = Awaited<ReturnType<typeof getCalApi>>;
    let api: CalApi | null = null;

    const persistReschedule = async (event: unknown): Promise<boolean> => {
      const newData = extractBookingDataFromEvent(event);
      if (!newData.uid || !newData.startTime) return false;

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
      completedRef.current = true;
      setPhase('completing');

      await persistReschedule(event);
      router.refresh();
      onClose();
    };

    const handleLinkFailed = (e: EmbedEvent<'linkFailed'>) => {
      if (cancelled || completedRef.current) return;
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
    setEmbedMode('new_slot');
    setErrorMessage(null);
    setPhase('embed');
    setEmbedKey((k) => k + 1);
  };

  const retryReschedule = () => {
    completedRef.current = false;
    setEmbedMode('reschedule');
    setErrorMessage(null);
    setPhase('embed');
    setEmbedKey((k) => k + 1);
  };

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
          <div className="flex min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
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

interface ExtractedBookingData {
  uid: string | null;
  startTime: string | null;
  endTime: string | null;
}

/**
 * Pull `uid`, `startTime`, `endTime` out of a Cal embed event detail
 * regardless of which event version fired.
 *
 * Shape variance we have to handle:
 *   • V2 events (`bookingSuccessfulV2`, `rescheduleBookingSuccessfulV2`)
 *     put the fields flat on `detail.data`.
 *   • V1 events (`bookingSuccessful`, `rescheduleBookingSuccessful`)
 *     nest them inside `detail.data.booking`. The shape of `booking`
 *     varies across Cal builds — uid is usually present at the top
 *     level, start/end may live under `startTime`/`endTime` or
 *     under a `start`/`end` alias.
 *
 * Everything is best-effort: callers must handle the null-fields
 * case (in which we fall back to a plain `router.refresh()` and let
 * the webhook reconcile state).
 */
function extractBookingDataFromEvent(event: unknown): ExtractedBookingData {
  const fallback: ExtractedBookingData = {
    uid: null,
    startTime: null,
    endTime: null,
  };
  if (!event || typeof event !== 'object') return fallback;
  const detail = (event as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return fallback;
  const data = (detail as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return fallback;

  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const flat = data as Record<string, unknown>;
  const directUid = asString(flat.uid);
  const directStart = asString(flat.startTime) ?? asString(flat.start);
  const directEnd = asString(flat.endTime) ?? asString(flat.end);

  if (directUid || directStart || directEnd) {
    return {
      uid: directUid,
      startTime: directStart,
      endTime: directEnd,
    };
  }

  // V1 nested shape — `data.booking` is the booking object.
  const booking = flat.booking;
  if (booking && typeof booking === 'object') {
    const b = booking as Record<string, unknown>;
    return {
      uid: asString(b.uid),
      startTime: asString(b.startTime) ?? asString(b.start),
      endTime: asString(b.endTime) ?? asString(b.end),
    };
  }

  return fallback;
}
