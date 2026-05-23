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
  Upload,
  User,
  X,
} from 'lucide-react';

import type {
  Appointment,
  Client,
  ClientAppointment,
  ClientPhoto,
} from './types';
import { cleanServiceName, clientDisplayName } from './helpers';

// ─── PUBLIC TYPES ──────────────────────────────────────────────────────────

interface Props {
  /**
   * The appointment we drilled in from. We use it as the source of
   * truth for the client's phone (the CRM identifier) plus
   * best-effort name/email fallbacks if this is a first-touch
   * create.
   */
  appointment: Appointment;
  /**
   * "← Back to appointment" — restores the appointment detail view
   * inside the parent modal shell without closing it.
   */
  onBackToAppointment: () => void;
  /** Closes the entire modal (parent's X handler). */
  onClose: () => void;
}

type ProfileView = 'overview' | 'appointments' | 'pictures' | 'edit_info';

// ─── ROOT ───────────────────────────────────────────────────────────────────

export default function ClientProfileModal({
  appointment,
  onBackToAppointment,
  onClose,
}: Props) {
  const [view, setView] = useState<ProfileView>('overview');

  // The Client record we're working with. Null while the first
  // POST is in flight. After mount this is the SINGLE source of
  // truth for the modal's identity boxes; PATCH responses replace
  // it in place so the UI reflects edits immediately.
  const [client, setClient] = useState<Client | null>(null);
  const [clientErr, setClientErr] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  // First-touch upsert. We POST the appointment's contact info — the
  // API will either return the existing row (if a clients record
  // already exists for this phone) or create one. Either way we get
  // back a Client we can render.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
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
    appointment.client_phone,
    appointment.client_first_name,
    appointment.client_last_name,
    appointment.client_email,
  ]);

  // Body sub-views need to push a "back" button when they're not at
  // the root. Centralising the header here keeps the chrome
  // consistent — every view sees the same close X in the same place
  // and the same back affordance shape.
  const isRoot = view === 'overview';

  return (
    <>
      <ProfileHeader
        appointment={appointment}
        client={client}
        view={view}
        onBack={
          isRoot
            ? onBackToAppointment
            : () => setView('overview')
        }
        backLabel={isRoot ? 'Appointment' : 'Profile'}
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
  appointment,
  client,
  view,
  onBack,
  backLabel,
  onClose,
}: {
  appointment: Appointment;
  client: Client | null;
  view: ProfileView;
  onBack: () => void;
  backLabel: string;
  onClose: () => void;
}) {
  // Title: while bootstrapping we fall back to the appointment's name
  // so the header doesn't flash "Unknown". Subtitle adapts to the
  // current view so the admin always knows where they are.
  const displayName = client
    ? clientDisplayName(client.first_name, client.last_name)
    : clientDisplayName(
        appointment.client_first_name,
        appointment.client_last_name
      );

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
  const [appts, setAppts] = useState<ClientAppointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        return res.json() as Promise<{ appointments: ClientAppointment[] }>;
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
  }, [client.id]);

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
  const now = Date.now();
  const upcoming: ClientAppointment[] = [];
  const past: ClientAppointment[] = [];
  for (const a of appts) {
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

  return (
    <div className="flex flex-col gap-4">
      {upcoming.length > 0 && (
        <Section label="Upcoming">
          <div className="flex flex-col gap-2">
            {upcoming.map((a) => (
              <AppointmentRow key={a.id} appointment={a} />
            ))}
          </div>
        </Section>
      )}
      {past.length > 0 && (
        <Section label="Past">
          <div className="flex flex-col gap-2">
            {past.map((a) => (
              <AppointmentRow key={a.id} appointment={a} />
            ))}
          </div>
        </Section>
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

function AppointmentRow({ appointment }: { appointment: ClientAppointment }) {
  const start = appointment.booking_time
    ? parseISO(appointment.booking_time)
    : null;
  const end = appointment.end_time ? parseISO(appointment.end_time) : null;

  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());

  const status = (appointment.status || '').toLowerCase();
  const isCancelled = status === 'cancelled';

  return (
    <div
      className={`rounded-lg border border-stone-200 bg-white p-3 ${
        isCancelled ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`font-serif text-base leading-tight text-stone-900 ${
              isCancelled ? 'line-through decoration-stone-400' : ''
            }`}
          >
            {cleanServiceName(appointment.service_name)}
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
        {isCancelled && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-amber-700">
            Cancelled
          </span>
        )}
      </div>
    </div>
  );
}

// ─── PICTURES (with lightbox) ──────────────────────────────────────────────

function PicturesView({ client }: { client: Client }) {
  const [photos, setPhotos] = useState<ClientPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
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
      setUploading(true);
      setUploadError(null);
      try {
        const form = new FormData();
        form.append('file', file);
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
        setUploading(false);
      }
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
                Uploading
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
        <Lightbox photo={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function Lightbox({
  photo,
  onClose,
}: {
  photo: ClientPhoto;
  onClose: () => void;
}) {
  // ESC closes. Bound at window so it works regardless of focus
  // — the lightbox doesn't have a natural focus target.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="presentation"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
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

