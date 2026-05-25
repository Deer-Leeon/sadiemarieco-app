'use client';

/**
 * ClientProfileModal — the in-app CRM drill-down rendered inside
 * AppointmentModal's shell. Owns its own internal view state
 * ('overview' | 'appointments' | 'pictures' | 'edit_info') and
 * fetches the canonical client record on mount via POST /api/admin/clients
 * (first-touch lock-in: creates the row if it didn't exist).
 *
 * Why a single component with internal views rather than a router:
 *   * The whole flow lives inside a modal — we don't want URL state
 *     for this. The admin lands here from the appointment modal and
 *     the modal closing should drop them straight back to whatever
 *     calendar view they were on.
 *   * Internal views keep the "← Back" affordance trivial: every
 *     non-overview view bounces to 'overview' with one setState.
 *
 * Lifecycle:
 *   1. Mount → POST /api/admin/clients with the appointment's
 *      client_phone (+ best-effort name/email). Server returns the
 *      existing or freshly-created Client.
 *   2. View switch → fetch lazily. Photos and appointments aren't
 *      loaded until the admin opens those views. Refreshing the
 *      profile after an edit only re-fetches the client record.
 *
 * Premium aesthetic discipline:
 *   - cream (#FAF9F6) page background, stone borders, serif headings
 *   - rounded-lg cards with subtle borders
 *   - icons from lucide-react (matches the rest of the admin)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import imageCompression from 'browser-image-compression';
import {
  ArrowLeft,
  Calendar,
  Camera,
  ChevronRight,
  ClipboardCheck,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  Scissors,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';

import type { Appointment, Client, ClientPhoto } from './types';
import { appointmentServiceLabel, clientDisplayName } from './helpers';
import { getServiceColor } from './serviceColors';
// Circular import: AppointmentModal imports ClientProfileModal (for the
// "Client" tab) and ClientProfileModal imports AppointmentModal (for
// the stacked "manage this appointment" overlay launched from the
// appointment-history list). Both references are inside component
// bodies (not module-init), so the bundler resolves them lazily on
// first render and the cycle is harmless.
import AppointmentModal from './AppointmentModal';

// ─── PUBLIC TYPES ──────────────────────────────────────────────────────────

/**
 * Common props shared by both entry-point variants.
 *
 * `backLabel` is required (rather than defaulted) so the caller
 * has to explicitly choose what the back button reads as — it's
 * the only visible chrome that telegraphs where the user came
 * from, and a stale default would be worse than a build error.
 */
interface BaseProps {
  /** Restores the previous view (typically by closing this modal). */
  onBack: () => void;
  /** Text on the back affordance, e.g. 'Appointment' or 'Clients'. */
  backLabel: string;
  /** Closes the entire modal (parent's X handler). */
  onClose: () => void;
}

/**
 * "From appointment" entry: the admin drilled in from an
 * appointment row. The modal first-touch-upserts a `clients` row
 * keyed by the appointment's phone so it works even on bookings
 * that predate the CRM.
 */
interface FromAppointmentProps extends BaseProps {
  appointment: Appointment;
  initialClient?: never;
}

/**
 * "From client directory" entry: the admin clicked a row in
 * `/admin/clients`. We already have the canonical Client in hand,
 * so the modal skips the first-touch upsert entirely and seeds
 * state from the supplied row. The bootstrap effect is a no-op in
 * this mode.
 */
interface FromClientProps extends BaseProps {
  initialClient: Client;
  appointment?: never;
}

type Props = FromAppointmentProps | FromClientProps;

type ProfileView = 'overview' | 'appointments' | 'pictures' | 'edit_info';

// ─── ROOT ───────────────────────────────────────────────────────────────────

export default function ClientProfileModal(props: Props) {
  const { onBack, backLabel, onClose } = props;
  const appointment = props.appointment;
  const initialClient = props.initialClient;

  const [view, setView] = useState<ProfileView>('overview');

  // The Client record we're working with. When entering from the
  // directory we seed this immediately from `initialClient` and
  // skip the bootstrap roundtrip — the source of truth already
  // exists in props. When entering from an appointment we leave
  // it null until the first-touch POST resolves.
  const [client, setClient] = useState<Client | null>(initialClient ?? null);
  const [clientErr, setClientErr] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(
    initialClient ? false : true
  );

  // First-touch upsert — appointment-entry only. We POST the
  // appointment's contact info; the API either returns the
  // existing row (if a clients record already exists for this
  // phone) or creates one. Either way we get back a Client we can
  // render. Skipped when `initialClient` was provided.
  useEffect(() => {
    if (!appointment) return; // directory entry — nothing to bootstrap
    let cancelled = false;
    async function bootstrap() {
      // Narrowing for the closure — TypeScript can't see through
      // the outer guard when the effect body re-references the
      // captured variable.
      if (!appointment) return;
      setBootstrapping(true);
      setClientErr(null);
      try {
        const res = await fetch('/api/admin/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: appointment.client_phone || '',
            first_name: appointment.client_first_name || null,
            last_name: appointment.client_last_name || null,
            email: appointment.client_email || null,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as { client: Client };
        if (!cancelled) setClient(data.client);
      } catch (err) {
        if (!cancelled) {
          setClientErr(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
    // appointment.client_phone is the identity — we re-bootstrap only
    // if the parent passes a different appointment, which in practice
    // doesn't happen mid-modal but keeps the effect honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appointment?.client_phone,
    appointment?.client_first_name,
    appointment?.client_last_name,
    appointment?.client_email,
  ]);

  // Header fallback name — only used in the brief bootstrap
  // window when `client` is still null. From the appointment
  // entry we have name fields on the appointment; from the
  // directory we always have `initialClient` so this never
  // shows the fallback.
  const fallbackName = appointment
    ? clientDisplayName(
        appointment.client_first_name,
        appointment.client_last_name
      )
    : clientDisplayName(
        initialClient?.first_name ?? null,
        initialClient?.last_name ?? null
      );

  // Body sub-views need to push a "back" button when they're not at
  // the root. Centralising the header here keeps the chrome
  // consistent — every view sees the same close X in the same place
  // and the same back affordance shape.
  const isRoot = view === 'overview';

  return (
    <>
      <ProfileHeader
        fallbackName={fallbackName}
        client={client}
        view={view}
        onBack={isRoot ? onBack : () => setView('overview')}
        backLabel={isRoot ? backLabel : 'Profile'}
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {bootstrapping ? (
          <CenteredSpinner label="Loading client…" />
        ) : clientErr ? (
          <InlineError
            message={`Couldn't load client. ${clientErr}`}
            onRetry={() => {
              setView('overview');
              setClient(null);
              setClientErr(null);
              setBootstrapping(true);
              // Re-run the bootstrap effect by toggling state — the
              // effect's deps include appointment fields so we
              // re-trigger by reloading. Simpler: just reload page.
              window.location.reload();
            }}
          />
        ) : client ? (
          <ProfileBody
            view={view}
            client={client}
            onChangeView={setView}
            onClientPatched={setClient}
          />
        ) : null}
      </div>
    </>
  );
}

// ─── HEADER ─────────────────────────────────────────────────────────────────

function ProfileHeader({
  fallbackName,
  client,
  view,
  onBack,
  backLabel,
  onClose,
}: {
  /**
   * Displayed in the header title while `client` is still null
   * (the brief bootstrap window when entering from an
   * appointment). Once `client` resolves we always prefer its
   * canonical name. Caller is responsible for composing a sensible
   * fallback — see the parent's `fallbackName` derivation.
   */
  fallbackName: string;
  client: Client | null;
  view: ProfileView;
  onBack: () => void;
  backLabel: string;
  onClose: () => void;
}) {
  // Title: while bootstrapping we fall back to the supplied name
  // so the header doesn't flash "Unknown". Subtitle adapts to the
  // current view so the admin always knows where they are.
  const displayName = client
    ? clientDisplayName(client.first_name, client.last_name)
    : fallbackName;

  const subtitle = (
    {
      overview: 'Client profile',
      appointments: 'Appointment history',
      pictures: 'Photo gallery',
      edit_info: 'Edit information',
    } as Record<ProfileView, string>
  )[view];

  return (
    <div className="relative flex items-center justify-between gap-3 border-b border-stone-200 bg-[#FAF9F6] px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-stone-700 transition-colors hover:bg-stone-100"
        >
          <ArrowLeft className="h-3 w-3" />
          {backLabel}
        </button>
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
            {subtitle}
          </p>
          <h2 className="truncate font-serif text-xl text-stone-900">
            {displayName}
          </h2>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── BODY ROUTER ────────────────────────────────────────────────────────────

function ProfileBody({
  view,
  client,
  onChangeView,
  onClientPatched,
}: {
  view: ProfileView;
  client: Client;
  onChangeView: (v: ProfileView) => void;
  onClientPatched: (c: Client) => void;
}) {
  if (view === 'overview') {
    return <OverviewView client={client} onChangeView={onChangeView} />;
  }
  if (view === 'appointments') {
    return <AppointmentsView client={client} />;
  }
  if (view === 'pictures') {
    return <PicturesView client={client} />;
  }
  if (view === 'edit_info') {
    return (
      <EditInfoView
        client={client}
        onCancel={() => onChangeView('overview')}
        onSaved={(updated) => {
          onClientPatched(updated);
          onChangeView('overview');
        }}
      />
    );
  }
  return null;
}

// ─── OVERVIEW ───────────────────────────────────────────────────────────────

function OverviewView({
  client,
  onChangeView,
}: {
  client: Client;
  onChangeView: (v: ProfileView) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <IdentityBox client={client} onEdit={() => onChangeView('edit_info')} />

      <ActionBox
        icon={<Calendar className="h-3 w-3" />}
        label="Appointments History"
        helper="Past and upcoming bookings for this client."
        onClick={() => onChangeView('appointments')}
      />
      <ActionBox
        icon={<Camera className="h-3 w-3" />}
        label="Photo Gallery"
        helper="Reference photos for lash sets, brow shapes, and dye colours."
        onClick={() => onChangeView('pictures')}
      />
      <ActionBox
        icon={<ClipboardCheck className="h-3 w-3" />}
        label="Consent Form"
        helper="Digital intake & consent."
        disabled
        rightAccessory={
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400">
            Coming soon
          </span>
        }
      />
    </div>
  );
}

function IdentityBox({
  client,
  onEdit,
}: {
  client: Client;
  onEdit: () => void;
}) {
  const name = clientDisplayName(client.first_name, client.last_name);
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
          <User className="h-3 w-3" />
          Client
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>

      <p className="font-serif text-xl leading-tight text-stone-900">{name}</p>

      <div className="mt-3 space-y-1.5 text-sm">
        {client.phone && (
          <a
            href={`tel:${client.phone}`}
            className="flex items-center gap-2 text-stone-700 transition-colors hover:text-stone-900"
          >
            <Phone className="h-3.5 w-3.5 text-stone-400" />
            <span className="font-mono text-[13px]">{formatPhone(client.phone)}</span>
          </a>
        )}
        {client.email && (
          <a
            href={`mailto:${client.email}`}
            className="flex items-center gap-2 text-stone-700 transition-colors hover:text-stone-900"
          >
            <Mail className="h-3.5 w-3.5 text-stone-400" />
            <span className="text-[13px]">{client.email}</span>
          </a>
        )}
        {!client.phone && !client.email && (
          <p className="text-xs italic text-stone-400">
            No contact details on file.
          </p>
        )}
      </div>
    </div>
  );
}

function ActionBox({
  icon,
  label,
  helper,
  onClick,
  disabled,
  rightAccessory,
}: {
  icon: React.ReactNode;
  label: string;
  helper: string;
  onClick?: () => void;
  disabled?: boolean;
  rightAccessory?: React.ReactNode;
}) {
  const interactive = !disabled && !!onClick;
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      className={`group flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-4 text-left transition-colors ${
        interactive
          ? 'cursor-pointer hover:border-stone-300 hover:bg-stone-50'
          : 'cursor-not-allowed opacity-70'
      }`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
          {icon}
          {label}
        </span>
        <span className="mt-1.5 block text-xs text-stone-500">{helper}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {rightAccessory ?? (
          <ChevronRight className="h-4 w-4 text-stone-400 transition-transform group-hover:translate-x-0.5" />
        )}
      </span>
    </button>
  );
}

// ─── APPOINTMENTS ───────────────────────────────────────────────────────────

function AppointmentsView({ client }: { client: Client }) {
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The appointment currently open in the stacked AppointmentModal,
  // or null when no modal is up. Clicking any history row sets this;
  // the modal closing clears it.
  const [openAppointment, setOpenAppointment] = useState<Appointment | null>(
    null
  );
  // Bumped whenever an actual mutation happens inside the stacked
  // modal (cancel / no-show / reschedule), which re-runs the fetch
  // effect below. Just opening and closing an appointment without
  // changes leaves this untouched — so the list stays exactly as it
  // was and no network roundtrip happens at all.
  const [refreshKey, setRefreshKey] = useState(0);

  // Set by the stacked AppointmentModal's onMutated callback when
  // the admin actually changes the booking (cancel / no-show /
  // reschedule). Read by `handleCloseStacked` below to decide
  // whether to bump `refreshKey`. Declared with the other hooks so
  // it stays above the early returns further down — moving it past
  // them is a Rules-of-Hooks violation and caused an infinite
  // remount + refetch loop in an earlier iteration.
  const mutatedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/clients/${client.id}/appointments`)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<{ appointments: Appointment[] }>;
      })
      .then((data) => {
        if (!cancelled) setAppts(data.appointments);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client.id, refreshKey]);

  if (loading) return <CenteredSpinner label="Loading history…" />;
  if (error) return <InlineError message={error} />;
  if (!appts || appts.length === 0) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-8 text-center">
        <Calendar className="mx-auto mb-3 h-6 w-6 text-stone-400" />
        <p className="text-sm text-stone-600">
          No appointments on file for this client yet.
        </p>
      </div>
    );
  }

  // Split into upcoming vs past for a more scannable view. Future
  // bookings are the most useful at a glance, so they sit on top
  // and we leave a subtle divider before the historical rows.
  //
  // Pending rows (slot picked, checkout not finished) never belong in
  // a client's history — only confirmed bookings and cancellations.
  const visibleAppts = appts.filter(
    (a) => (a.status || '').toLowerCase() !== 'pending'
  );
  if (visibleAppts.length === 0) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-8 text-center">
        <Calendar className="mx-auto mb-3 h-6 w-6 text-stone-400" />
        <p className="text-sm text-stone-600">
          No appointments on file for this client yet.
        </p>
      </div>
    );
  }

  const now = Date.now();
  const upcoming: Appointment[] = [];
  const past: Appointment[] = [];
  for (const a of visibleAppts) {
    const t = a.booking_time ? parseISO(a.booking_time).getTime() : NaN;
    if (Number.isFinite(t) && t >= now) {
      upcoming.push(a);
    } else {
      past.push(a);
    }
  }
  // Upcoming list naturally sorts ASC (soonest first), past stays
  // DESC (most recent first).
  upcoming.sort((a, b) => {
    const ta = a.booking_time ? parseISO(a.booking_time).getTime() : 0;
    const tb = b.booking_time ? parseISO(b.booking_time).getTime() : 0;
    return ta - tb;
  });

  const handleSelect = (a: Appointment) => setOpenAppointment(a);

  const handleCloseStacked = () => {
    setOpenAppointment(null);
    // Only refetch when the booking actually changed. A pure
    // open-and-close (admin just peeked at details) skips the
    // network roundtrip entirely and snaps straight back to the
    // already-rendered list — no spinner, no flicker.
    if (mutatedRef.current) {
      setRefreshKey((k) => k + 1);
      mutatedRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {upcoming.length > 0 && (
        <Section label="Upcoming">
          <div className="flex flex-col gap-2">
            {upcoming.map((a) => (
              <AppointmentRow
                key={a.id}
                appointment={a}
                onSelect={() => handleSelect(a)}
              />
            ))}
          </div>
        </Section>
      )}
      {past.length > 0 && (
        <Section label="Past">
          <div className="flex flex-col gap-2">
            {past.map((a) => (
              <AppointmentRow
                key={a.id}
                appointment={a}
                onSelect={() => handleSelect(a)}
              />
            ))}
          </div>
        </Section>
      )}

      {openAppointment && (
        <AppointmentModal
          appointment={openAppointment}
          onClose={handleCloseStacked}
          onMutated={() => {
            mutatedRef.current = true;
          }}
          stacked
        />
      )}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function AppointmentRow({
  appointment,
  onSelect,
}: {
  appointment: Appointment;
  onSelect: () => void;
}) {
  const start = appointment.booking_time
    ? parseISO(appointment.booking_time)
    : null;
  const end = appointment.end_time ? parseISO(appointment.end_time) : null;

  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());

  // In the CLIENT PROFILE we explicitly do NOT filter canceled/no-show
  // rows — they're audit history. Each non-confirmed status gets its
  // own colour-coded badge + a struck-through row so McKenna can see
  // at a glance how this client has historically behaved with their
  // bookings (cancellations, no-shows, etc.).
  const badge = describeRowBadge(appointment.status);
  const dim = badge !== null;
  // Service-type colour coding in the client profile reads as a thin
  // 4 px left accent only — the row body stays the standard white
  // card so a single client's history scans as a calm list rather
  // than a multi-coloured wall. The calendar views (list / 3-day /
  // week / month / single-day) still paint the full block so the
  // colour signal stays loud where the studio actually plans the
  // day. Suppressed for any non-confirmed row (cancelled/no-show)
  // so the existing dimmed-grey status treatment isn't overpowered —
  // the colour belongs to live bookings only, the badge carries the
  // meaning otherwise.
  const color = dim ? null : getServiceColor(appointment);
  const colorStyle = color
    ? { borderLeftWidth: '4px', borderLeftColor: color.accent }
    : undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open appointment · ${appointmentServiceLabel(appointment)}`}
      className={`group w-full rounded-lg border border-stone-200 bg-white p-3 text-left transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF9F6] ${
        dim ? 'opacity-70' : ''
      }`}
      style={colorStyle}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`font-serif text-base leading-tight ${
              dim
                ? 'text-stone-500 line-through decoration-stone-400'
                : 'text-stone-900'
            }`}
          >
            {appointmentServiceLabel(appointment)}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            {hasStart
              ? `${format(start!, 'EEE, MMM d, yyyy')} · ${
                  hasEnd
                    ? `${format(start!, 'h:mm a')} – ${format(end!, 'h:mm a')}`
                    : format(start!, 'h:mm a')
                }`
              : 'No time scheduled'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge !== null && (
            <span
              className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] ${badge.className}`}
            >
              {badge.label}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 text-stone-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-stone-600"
          />
        </div>
      </div>
    </button>
  );
}

/**
 * Map an appointment-history row's status to its badge label + style.
 * Returning `null` for 'confirmed' tells the renderer to render the row
 * undecorated, which is the right visual default for the most common
 * lifecycle state. Unknown / legacy values fall through to `null` too
 * — better than rendering a confusing "raw db value" pill.
 *
 * Legacy note: the British 'cancelled' value from before
 * `scripts/update_status_constraint.sql` ran is treated as
 * 'canceled_by_client' (which is what the migration converts it to)
 * so historical rows render correctly even if the migration hasn't
 * been applied to a particular environment yet.
 */
function describeRowBadge(
  status: string | null
): { label: string; className: string } | null {
  const s = (status || '').toLowerCase();
  // `pending` is filtered out of client history before rows render.
  if (s === 'canceled_by_admin') {
    return {
      label: 'Cancelled by you',
      className: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/70',
    };
  }
  if (s === 'canceled_by_client' || s === 'cancelled') {
    return {
      label: 'Cancelled by client',
      className: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/70',
    };
  }
  if (s === 'canceled_by_system') {
    // Abandoned-checkout cron released the hold — not a manual cancel.
    // Muted stone styling distinguishes this from client/admin cancels.
    return {
      label: 'Cancelled by system',
      className: 'bg-stone-100 text-stone-500 ring-1 ring-stone-300/60',
    };
  }
  if (s === 'no-show') {
    return {
      label: 'No-show',
      className: 'bg-stone-100 text-stone-600 ring-1 ring-stone-300/70',
    };
  }
  return null;
}

// ─── PICTURES (with lightbox) ──────────────────────────────────────────────

// iPhones emit HEIC/HEIF by default — Chrome/Firefox on desktop can't
// decode them, which broke both browser-image-compression and Vercel
// Blob's content sniffer. Detect by MIME first (most reliable) and
// fall back to filename extension for browsers/OSes that leave the
// File.type empty for HEIC.
function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === 'image/heic' || mime === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
}

// Convert a HEIC/HEIF File to a real JPEG File. We try every
// available path in order of preference:
//
//   1. Native browser decoder. Chrome 121+ on macOS, Safari, and
//      Edge (Windows w/ HEIF codec) can decode HEIC straight into
//      an <img>. We blit that to a canvas and re-encode as JPEG.
//      Zero library cost and handles modern HEIC variants
//      (10-bit, HDR, P3) that older WASM decoders choke on.
//
//   2. heic2any (libheif-js WASM). Fallback for browsers without
//      native HEIC support — Firefox, Chrome on bare Windows.
//      Note: ships an old libheif build that rejects newer Apple
//      HEIC profiles with `ERR_LIBHEIF format not supported`, so
//      this path will fail on iPhone 12 Pro+ HDR shots.
async function convertHeicToJpeg(file: File): Promise<File> {
  const targetName = file.name.replace(/\.(heic|heif)$/i, '.jpg');

  // ── 1. Native browser decoder ─────────────────────────────────
  try {
    return await decodeImageToJpegFile(file, targetName);
  } catch (nativeErr) {
    console.warn(
      '[ClientProfileModal] native HEIC decode failed, falling back to heic2any',
      nativeErr
    );
  }

  // ── 2. heic2any (libheif-js WASM) ─────────────────────────────
  const { default: heic2any } = await import('heic2any');
  const converted = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.92,
  });
  const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
  return new File([jpegBlob], targetName, {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

// Decode any browser-supported image format (incl. HEIC when the
// OS decoder is available) to a JPEG File via canvas.
async function decodeImageToJpegFile(
  file: File,
  targetName: string
): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new Error('Browser cannot decode this image format'));
      el.src = url;
    });

    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error('Image decoded to zero dimensions');
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not obtain 2D canvas context');
    ctx.drawImage(img, 0, 0);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    );
    if (!blob) throw new Error('Canvas → JPEG export returned empty blob');

    return new File([blob], targetName, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// heic2any (and other worker-backed libs) routinely reject with a
// raw DOM Event instead of an Error, which makes `.message` return
// undefined and our user-facing toast collapse to "unknown error".
// This pulls something useful out regardless of the rejection shape.
function describeUnknownError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const target = err.target as
      | { error?: { message?: string }; src?: string }
      | null;
    if (target?.error?.message) return target.error.message;
    return `${err.type || 'event'} from ${target?.src ?? 'worker'}`;
  }
  if (err && typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage) return maybeMessage;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // fall through
    }
    return Object.prototype.toString.call(err);
  }
  return String(err);
}

function PicturesView({ client }: { client: Client }) {
  const [photos, setPhotos] = useState<ClientPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Two-stage upload state so the UI can distinguish the
  // (CPU-bound, occasionally slow) client-side compression
  // pass from the actual network upload. Both phases disable
  // the button; only the label changes.
  const [uploadPhase, setUploadPhase] = useState<
    'idle' | 'converting' | 'compressing' | 'uploading'
  >('idle');
  const uploading = uploadPhase !== 'idle';
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<ClientPhoto | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/clients/${client.id}/photos`)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<{ photos: ClientPhoto[] }>;
      })
      .then((data) => {
        if (!cancelled) setPhotos(data.photos);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client.id]);

  const onUploadClick = () => {
    if (uploading) return;
    fileInputRef.current?.click();
  };

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      // Reset the input so the same file can be picked again next
      // time (browsers don't fire `change` for identical re-select).
      input.value = '';
      if (!file) return;

      // Flip the spinner on IMMEDIATELY so the user sees feedback
      // even before the HEIC→JPEG conversion / compression starts —
      // both can take 1-2 s on older devices.
      const isHeic = isHeicFile(file);
      setUploadPhase(isHeic ? 'converting' : 'compressing');
      setUploadError(null);

      try {
        // iPhone HEIC/HEIF → JPEG. The conversion helper tries
        // the native browser decoder first (Chrome 121+ on macOS,
        // Safari, Edge w/ HEIF codec) and falls back to heic2any.
        // BOTH can fail on newer iPhone HEIC variants (HDR /
        // 10-bit / Live Photo sequences) which Apple ships by
        // default on iPhone 12 Pro+. When that happens we don't
        // block — the server route runs sharp (libvips + libheif,
        // current build) which handles every Apple HEIC profile.
        let workingFile: File = file;
        if (isHeic) {
          try {
            workingFile = await convertHeicToJpeg(file);
          } catch (convertErr) {
            console.warn(
              '[ClientProfileModal] client-side HEIC decode failed — deferring conversion to the server',
              {
                raw: convertErr,
                file: {
                  name: file.name,
                  type: file.type || '(empty)',
                  size: file.size,
                },
              }
            );
            // workingFile stays as the raw HEIC. Skip the
            // browser-image-compression pass below — it'd fail
            // for the same reason heic2any did.
          }
          setUploadPhase('compressing');
        }

        // Client-side compression keeps us comfortably under
        // Vercel's 4.5 MB serverless request-body cap. Modern
        // phone cameras routinely emit 5-10 MB JPEGs which were
        // tripping HTTP 413 (file_too_large) at the edge before
        // they ever reached our route handler. We only run this
        // on files we KNOW the browser can decode — raw HEIC
        // would just fail in the canvas read and waste 1-2 s.
        let uploadFile: File = workingFile;
        const stillHeic = isHeicFile(workingFile);
        if (workingFile.type.startsWith('image/') && !stillHeic) {
          try {
            const compressed = await imageCompression(workingFile, {
              maxSizeMB: 1,
              maxWidthOrHeight: 1920,
              useWebWorker: true,
            });
            // The lib returns a File whose `name` may have been
            // rewritten (e.g. ".heic" → ".jpeg" via re-encoding).
            // Re-wrap to lock in the working filename so the
            // server's existing `${Date.now()}-${rand}-${name}`
            // unique-suffix logic stays deterministic.
            uploadFile = new File([compressed], workingFile.name, {
              type: compressed.type || workingFile.type,
              lastModified: workingFile.lastModified,
            });
          } catch (compressErr) {
            // Don't block the upload if compression itself fails
            // (OOM on very large images, unsupported codec, etc.).
            // Fall back to the working (post-conversion) file and
            // let the server reject it if it's too big.
            console.warn(
              '[ClientProfileModal] image compression failed; uploading original',
              compressErr
            );
          }
        }

        setUploadPhase('uploading');
        const form = new FormData();
        // Third arg to FormData.append pins the filename the server
        // sees, independent of `uploadFile.name`. Use the post-HEIC
        // name so the stored blob has a `.jpg` extension that
        // matches its actual bytes.
        form.append('file', uploadFile, workingFile.name);
        const res = await fetch(`/api/admin/clients/${client.id}/photos`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as { photo: ClientPhoto };
        setPhotos((prev) => (prev ? [data.photo, ...prev] : [data.photo]));
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploadPhase('idle');
      }
    },
    [client.id]
  );

  // Deletion is initiated from inside the Lightbox button. The
  // confirm dialog lives in the Lightbox too (so a cancelled
  // confirm doesn't reach us at all). On success we drop the row
  // from local state AND unmount the lightbox by clearing the
  // selection — that's why this lives in PicturesView, not in
  // the Lightbox itself.
  const handleDeletePhoto = useCallback(
    async (photoId: number, blobUrl: string) => {
      const res = await fetch(`/api/admin/clients/${client.id}/photos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, blobUrl }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setPhotos((prev) =>
        prev ? prev.filter((p) => p.id !== photoId) : prev
      );
      setLightbox(null);
    },
    [client.id]
  );

  if (loading) return <CenteredSpinner label="Loading photos…" />;
  if (error) return <InlineError message={error} />;

  return (
    <div className="flex flex-col gap-3">
      {uploadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          Upload failed — {uploadError}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onUploadClick}
          disabled={uploading}
          aria-label="Upload photo"
          className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-stone-300 bg-stone-50 text-stone-500 transition-colors ${
            uploading
              ? 'cursor-not-allowed opacity-70'
              : 'cursor-pointer hover:border-stone-400 hover:bg-stone-100 hover:text-stone-700'
          }`}
        >
          {uploading ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-[10px] font-medium uppercase tracking-[0.18em]">
                {uploadPhase === 'converting'
                  ? 'Converting'
                  : uploadPhase === 'compressing'
                    ? 'Processing'
                    : 'Uploading'}
              </span>
            </>
          ) : (
            <>
              <Plus className="h-6 w-6" strokeWidth={1.6} />
              <span className="text-[10px] font-medium uppercase tracking-[0.18em]">
                Upload
              </span>
            </>
          )}
        </button>

        {photos?.map((photo) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setLightbox(photo)}
            className="group relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-100 transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900"
            aria-label={`Open photo from ${format(parseISO(photo.uploaded_at), 'MMM d, yyyy')}`}
          >
            {/*
              Native <img> rather than next/image — these blobs are
              public Vercel-hosted images that the user just uploaded.
              next/image would require us to allow the blob hostname
              in next.config and would re-process every photo the
              admin uploads, which isn't needed here.
            */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.blob_url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          </button>
        ))}
      </div>

      {photos && photos.length === 0 && !uploading && (
        <p className="px-1 text-xs italic text-stone-400">
          No photos yet — use the upload tile to add reference shots.
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif"
        className="hidden"
        onChange={onFileChange}
      />

      {lightbox && (
        <Lightbox
          photo={lightbox}
          onClose={() => setLightbox(null)}
          onDelete={handleDeletePhoto}
        />
      )}
    </div>
  );
}

function Lightbox({
  photo,
  onClose,
  onDelete,
}: {
  photo: ClientPhoto;
  onClose: () => void;
  /**
   * Server round-trip + local state cleanup, owned by PicturesView.
   * Resolves on success (and PicturesView unmounts us by clearing
   * the lightbox selection), rejects on HTTP failure so we can
   * show an inline error pill below the delete button.
   */
  onDelete: (photoId: number, blobUrl: string) => Promise<void>;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // ESC handling, in priority order:
  //   1. If a request is mid-flight: do nothing.
  //   2. If the confirm dialog is open: dismiss the confirm
  //      (keeps the user in the lightbox).
  //   3. Otherwise: close the lightbox.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (isDeleting) return;
      if (showConfirm) {
        setShowConfirm(false);
        return;
      }
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isDeleting, showConfirm]);

  // Backdrop click closes the lightbox — but NOT while the confirm
  // dialog is open (that would yank the lightbox out from under
  // the dialog) and NOT during an in-flight delete.
  const onBackdropClick = () => {
    if (isDeleting || showConfirm) return;
    onClose();
  };

  const onDeleteClick = (e: React.MouseEvent) => {
    // Don't bubble to backdrop.
    e.stopPropagation();
    if (isDeleting) return;
    setDeleteError(null);
    setShowConfirm(true);
  };

  const cancelConfirm = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isDeleting) return;
    setShowConfirm(false);
  };

  const confirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeleting) return;
    setIsDeleting(true);
    setShowConfirm(false);
    try {
      await onDelete(photo.id, photo.blob_url);
      // Parent clears the lightbox selection on success, which
      // unmounts us — no further state work needed here.
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/90 p-4"
      onClick={onBackdropClick}
      role="presentation"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (isDeleting || showConfirm) return;
          onClose();
        }}
        disabled={isDeleting || showConfirm}
        aria-label="Close photo"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="h-5 w-5" />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.blob_url}
        alt=""
        className="max-h-full max-w-full rounded-md object-contain"
        onClick={(e) => e.stopPropagation()}
      />

      {/* Destructive trigger. Bottom-centred so the X stays clean
          and the user has to deliberately reach for it. Rose tint
          + subtle backdrop blur matches our admin aesthetic. */}
      <button
        type="button"
        onClick={onDeleteClick}
        disabled={isDeleting || showConfirm}
        aria-label="Delete photo"
        className="absolute bottom-6 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-rose-300/40 bg-rose-500/15 px-5 py-2.5 text-sm font-medium text-rose-100 backdrop-blur-sm transition-colors hover:border-rose-300/60 hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isDeleting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Deleting…</span>
          </>
        ) : (
          <>
            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
            <span>Delete photo</span>
          </>
        )}
      </button>

      {deleteError && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-md border border-rose-300/40 bg-rose-950/50 px-3 py-1.5 text-xs text-rose-100 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
          role="alert"
        >
          Couldn’t delete — {deleteError}
        </div>
      )}

      {/* Custom confirm dialog. Replaces the native window.confirm
          so the destructive prompt matches the rest of the admin
          UI (cream card, serif heading, rose CTA). Sits on top of
          the lightbox via z-110 (lightbox itself is z-100). */}
      {showConfirm && (
        <ConfirmDeleteDialog
          onCancel={cancelConfirm}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function ConfirmDeleteDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: (e?: React.MouseEvent) => void;
  onConfirm: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="absolute inset-0 z-110 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-photo-title"
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-6 pt-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
            <Trash2 className="h-5 w-5" strokeWidth={1.6} />
          </span>
          <div className="flex-1">
            <h3
              id="confirm-delete-photo-title"
              className="font-serif text-lg leading-tight text-stone-900"
            >
              Delete this photo?
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
              The photo will be permanently removed from the client’s gallery.
              This action cannot be undone.
            </p>
          </div>
        </div>

        {/* Footer / actions. Subtle divider matches the rest of
            our card UI; Cancel on the left as a safe escape hatch,
            destructive primary on the right. */}
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-stone-200/70 bg-stone-100/50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-500/40 focus:ring-offset-2 focus:ring-offset-stone-50"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
            Delete photo
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EDIT INFO ──────────────────────────────────────────────────────────────

function EditInfoView({
  client,
  onCancel,
  onSaved,
}: {
  client: Client;
  onCancel: () => void;
  onSaved: (updated: Client) => void;
}) {
  const [firstName, setFirstName] = useState(client.first_name ?? '');
  const [lastName, setLastName] = useState(client.last_name ?? '');
  const [email, setEmail] = useState(client.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    // Send fields that changed. Empty strings → null (explicit clear).
    const payload: Record<string, string | null> = {};
    const next = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email: email.trim().toLowerCase(),
    };
    const prev = {
      first_name: (client.first_name ?? '').trim(),
      last_name: (client.last_name ?? '').trim(),
      email: (client.email ?? '').trim().toLowerCase(),
    };
    if (next.first_name !== prev.first_name) {
      payload.first_name = next.first_name.length ? next.first_name : null;
    }
    if (next.last_name !== prev.last_name) {
      payload.last_name = next.last_name.length ? next.last_name : null;
    }
    if (next.email !== prev.email) {
      payload.email = next.email.length ? next.email : null;
    }
    if (Object.keys(payload).length === 0) {
      onCancel();
      return;
    }

    try {
      const res = await fetch(`/api/admin/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg =
          (data && typeof data === 'object' && 'message' in data
            ? (data as { message?: string }).message
            : null) || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const data = (await res.json()) as { client: Client };
      onSaved(data.client);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <p className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
          <Pencil className="h-3 w-3" />
          Edit profile
        </p>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <LabeledInput
              id="first_name"
              label="First name"
              value={firstName}
              onChange={setFirstName}
              autoComplete="given-name"
            />
            <LabeledInput
              id="last_name"
              label="Last name"
              value={lastName}
              onChange={setLastName}
              autoComplete="family-name"
            />
          </div>
          <LabeledInput
            id="email"
            label="Email"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            placeholder="client@example.com"
          />
          <p className="text-[11px] text-stone-500">
            Phone ({client.phone ? formatPhone(client.phone) : '—'}) is the
            client&rsquo;s unique identifier and can&rsquo;t be changed here.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-700 transition-colors hover:bg-stone-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Upload className="h-3 w-3" />
              Save changes
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function LabeledInput({
  id,
  label,
  value,
  onChange,
  type,
  placeholder,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-stone-500">
        {label}
      </span>
      <input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
      />
    </label>
  );
}

// ─── SHARED HELPERS ─────────────────────────────────────────────────────────

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-stone-500">
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-xs uppercase tracking-[0.18em]">{label}</p>
    </div>
  );
}

function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1 text-xs">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-white px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-rose-700 transition-colors hover:bg-rose-100"
        >
          <Scissors className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}

// Pretty-print a normalised (digits-only) US phone as (123) 456-7890.
// 10-digit and 11-digit (leading 1) forms render in the canonical US
// shape; anything else falls back to the raw digits so we don't
// mangle international numbers we don't recognise.
const formatPhoneCache = new Map<string, string>();
function formatPhone(digits: string): string {
  const cached = formatPhoneCache.get(digits);
  if (cached) return cached;
  let out = digits;
  if (digits.length === 10) {
    out = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    out = `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  formatPhoneCache.set(digits, out);
  return out;
}

