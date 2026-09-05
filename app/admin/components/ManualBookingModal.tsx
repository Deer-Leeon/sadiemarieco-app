'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';

import ManualBookingClientStep, {
  canAdvanceManualBookingClientStep,
  type ClientEntryMode,
  type ManualBookingClientFields,
} from './ManualBookingClientStep';
import ManualBookingServicePicker from './ManualBookingServicePicker';
import ManualBookingSlotPicker from './ManualBookingSlotPicker';
import type {
  ManualBookingServiceGroupHeader,
  ManualBookingServiceOption,
} from './manual-booking-utils';
import {
  clientPhoneValidationMessage,
  formatPhoneInputDisplay,
  isPlaceholderClientEmail,
  parseClientPhone,
} from '@/lib/client-identity';

import { clientDisplayName } from '../helpers';
import type { Client } from '../types';
import {
  bookingEndFromDuration,
  epochMsFromIsoUtc,
  extractCalBookingFromResponse,
  formatVisitDateInStudio,
  formatVisitTimeRange,
  joinFullName,
  slotToStudioLocalStart,
} from './manual-booking-utils';

type WizardStep = 1 | 2 | 3 | 4;

type PendingVisit = {
  id: string;
  service: ManualBookingServiceOption;
  slotIsoUtc: string;
  notes: string | null;
};

function newVisitId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `visit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Props {
  /** When omitted, the modal loads the catalogue from the API. */
  services?: ManualBookingServiceOption[];
  groupHeaders?: ManualBookingServiceGroupHeader[];
  /**
   * When set, skips the client-details step — the booking is for this
   * CRM client (service → schedule only).
   */
  prefilledClient?: Client;
  /** Studio day to open the slot picker on (calendar hour click). */
  seedDate?: Date;
  /** 0–23 studio hour to pre-select after service + client. */
  seedHour?: number;
  /** Optional Book / Block time control in the header (calendar click). */
  modeSwitch?: ReactNode;
  onClose: () => void;
  /**
   * Fired after each successful booking so the parent can toast + refresh.
   * Does not close the modal — the success step offers Done / Book another.
   */
  onSuccess: () => void;
}

const BTN_SECONDARY =
  'rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 disabled:opacity-50';

const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-full border border-stone-600 bg-stone-700 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition-colors hover:border-stone-700 hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-300 disabled:border-stone-200 disabled:bg-stone-300 disabled:text-stone-500';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Optional email for the API — null when blank / placeholder / invalid. */
function optionalEmailForApi(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || isPlaceholderClientEmail(trimmed)) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

function fieldsFromClient(client: Client): ManualBookingClientFields {
  return {
    firstName: client.first_name?.trim() || '',
    lastName: client.last_name?.trim() || '',
    phone: client.phone ? formatPhoneInputDisplay(client.phone) : '',
    email:
      client.email && !isPlaceholderClientEmail(client.email)
        ? client.email.trim()
        : '',
  };
}

function ManualBookingCompletingOverlay({
  progress,
}: {
  progress?: { current: number; total: number } | null;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Loader2 className="h-7 w-7 animate-spin text-stone-400" />
      <p className="font-serif text-lg text-stone-900">
        {progress && progress.total > 1
          ? `Booking ${progress.current} of ${progress.total}…`
          : 'Saving appointment…'}
      </p>
      <p className="text-sm text-stone-500">Updating Cal.com and your calendar</p>
    </div>
  );
}

function ManualBookingSuccessPanel({
  clientName,
  serviceTitle,
  count,
  onDone,
  onBookAnother,
}: {
  clientName: string;
  serviceTitle: string;
  count: number;
  onDone: () => void;
  onBookAnother: () => void;
}) {
  const plural = count > 1;
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
        <Check className="h-6 w-6" strokeWidth={2.25} aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <p className="font-serif text-xl text-stone-900">
          {plural ? `${count} appointments booked` : 'Appointment booked'}
        </p>
        <p className="text-sm text-stone-600">
          {plural ? (
            clientName ? (
              <>
                {count} visits for{' '}
                <span className="font-medium text-stone-800">{clientName}</span>
              </>
            ) : (
              `${count} visits saved`
            )
          ) : (
            <>
              <span className="font-medium text-stone-800">{serviceTitle}</span>
              {clientName ? (
                <>
                  {' '}
                  for <span className="font-medium text-stone-800">{clientName}</span>
                </>
              ) : null}
            </>
          )}
        </p>
        <p className="text-xs text-stone-500">
          Book another for the same client, or close when you&apos;re done.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        <button type="button" onClick={onDone} className={BTN_SECONDARY}>
          Done
        </button>
        <button type="button" onClick={onBookAnother} className={BTN_PRIMARY}>
          Book another
        </button>
      </div>
    </div>
  );
}

const EMPTY_FIELDS: ManualBookingClientFields = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
};

const NOTES_TEXTAREA_CLASS =
  'mt-1.5 block w-full resize-y rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-200 disabled:opacity-50';

/** Optional visit notes for the API — null when blank. */
function notesForApi(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;
}

export default function ManualBookingModal({
  services: servicesProp,
  groupHeaders: groupHeadersProp,
  prefilledClient,
  seedDate,
  seedHour,
  modeSwitch,
  onClose,
  onSuccess,
}: Props) {
  const initiallyClientLocked = Boolean(prefilledClient);

  const [services, setServices] = useState<ManualBookingServiceOption[]>(
    servicesProp ?? []
  );
  const [groupHeaders, setGroupHeaders] = useState<
    ManualBookingServiceGroupHeader[]
  >(groupHeadersProp ?? []);
  const [catalogLoading, setCatalogLoading] = useState(
    !(servicesProp && servicesProp.length > 0)
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [step, setStep] = useState<WizardStep>(1);
  const [phase, setPhase] = useState<'wizard' | 'success'>('wizard');
  /** After a successful book, keep the same client for “Book another”. */
  const [sessionClientLocked, setSessionClientLocked] = useState(false);
  const [lastBooked, setLastBooked] = useState<{
    clientName: string;
    serviceTitle: string;
    count: number;
  } | null>(null);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [pendingVisits, setPendingVisits] = useState<PendingVisit[]>([]);
  const [editingVisitId, setEditingVisitId] = useState<string | null>(null);
  const [bookingProgress, setBookingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [clientMode, setClientMode] = useState<ClientEntryMode>('existing');
  const [clientFields, setClientFields] = useState<ManualBookingClientFields>(
    () => (prefilledClient ? fieldsFromClient(prefilledClient) : EMPTY_FIELDS)
  );
  const [selectedClient, setSelectedClient] = useState<Client | null>(
    prefilledClient ?? null
  );
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [bookingNotes, setBookingNotes] = useState('');
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const isClientLocked =
    initiallyClientLocked || sessionClientLocked || pendingVisits.length > 0;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (servicesProp && servicesProp.length > 0) {
      setServices(servicesProp);
      setGroupHeaders(groupHeadersProp ?? []);
      setCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);

    void (async () => {
      try {
        const res = await fetch('/api/admin/manual-booking/services');
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            payload &&
            typeof payload === 'object' &&
            'message' in payload &&
            typeof (payload as { message: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : `Could not load services (HTTP ${res.status})`;
          if (!cancelled) setCatalogError(message);
          return;
        }
        const nextServices =
          payload &&
          typeof payload === 'object' &&
          'services' in payload &&
          Array.isArray((payload as { services: unknown }).services)
            ? ((payload as { services: ManualBookingServiceOption[] }).services)
            : [];
        const nextHeaders =
          payload &&
          typeof payload === 'object' &&
          'groupHeaders' in payload &&
          Array.isArray((payload as { groupHeaders: unknown }).groupHeaders)
            ? ((
                payload as { groupHeaders: ManualBookingServiceGroupHeader[] }
              ).groupHeaders)
            : [];
        if (!cancelled) {
          setServices(nextServices);
          setGroupHeaders(nextHeaders);
        }
      } catch (err) {
        if (!cancelled) {
          setCatalogError(
            err instanceof Error ? err.message : 'Could not load services'
          );
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [servicesProp, groupHeadersProp]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !completing) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, completing]);

  useEffect(() => {
    if (phase !== 'wizard') {
      setSelectedSlot(null);
      return;
    }
    if (step !== 3 && !editingVisitId) {
      setSelectedSlot(null);
    }
  }, [step, phase, editingVisitId]);

  function resolvedClientFields(): ManualBookingClientFields {
    if (clientMode === 'existing' && selectedClient) {
      return {
        firstName:
          selectedClient.first_name?.trim() || clientFields.firstName,
        lastName: selectedClient.last_name?.trim() || clientFields.lastName,
        phone: selectedClient.phone
          ? formatPhoneInputDisplay(selectedClient.phone)
          : clientFields.phone,
        email: (clientFields.email || selectedClient.email || '').trim(),
      };
    }
    return clientFields;
  }

  function discardDraft() {
    setEditingVisitId(null);
    setSelectedService(null);
    setSelectedSlot(null);
    setBookingNotes('');
  }

  function commitDraftToCart() {
    if (!selectedService || !selectedSlot) return false;
    const notes = notesForApi(bookingNotes);
    if (editingVisitId) {
      setPendingVisits((prev) =>
        prev.map((visit) =>
          visit.id === editingVisitId
            ? {
                ...visit,
                service: selectedService,
                slotIsoUtc: selectedSlot,
                notes,
              }
            : visit
        )
      );
    } else {
      setPendingVisits((prev) => [
        ...prev,
        {
          id: newVisitId(),
          service: selectedService,
          slotIsoUtc: selectedSlot,
          notes,
        },
      ]);
    }
    discardDraft();
    setSessionClientLocked(true);
    setStep(4);
    return true;
  }

  function beginAddVisit() {
    if (completing || pendingVisits.length === 0) return;
    setError(null);
    discardDraft();
    setStep(1);
  }

  function beginEditVisit(visit: PendingVisit, jumpToSchedule = false) {
    if (completing) return;
    setError(null);
    setEditingVisitId(visit.id);
    setSelectedService(visit.service);
    setBookingNotes(visit.notes ?? '');
    setSelectedSlot(visit.slotIsoUtc);
    setStep(jumpToSchedule ? 3 : 1);
  }

  function removeVisit(id: string) {
    if (completing) return;
    setError(null);
    const next = pendingVisits.filter((visit) => visit.id !== id);
    setPendingVisits(next);
    if (editingVisitId === id) {
      discardDraft();
    }
    if (next.length === 0) {
      discardDraft();
      setStep(1);
    }
  }

  async function bookOneVisit(
    visit: PendingVisit,
    trimmedFirst: string,
    trimmedLast: string,
    trimmedName: string,
    trimmedEmail: string | null,
    phoneDigits: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    let start: string;
    try {
      start = slotToStudioLocalStart(visit.slotIsoUtc);
    } catch {
      return { ok: false, message: 'Selected time is invalid. Please pick another slot.' };
    }

    const notes = visit.notes;

    const createRes = await fetch('/api/admin/manual-booking/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventTypeId: visit.service.eventTypeId,
        start,
        clientFirstName: trimmedFirst,
        clientLastName: trimmedLast,
        clientName: trimmedName,
        clientEmail: trimmedEmail,
        clientPhone: phoneDigits,
        ...(notes ? { bookingNotes: notes } : {}),
      }),
    });

    const createPayload: unknown = await createRes.json().catch(() => null);

    if (!createRes.ok) {
      const message =
        createPayload &&
        typeof createPayload === 'object' &&
        'message' in createPayload &&
        typeof (createPayload as { message: unknown }).message === 'string'
          ? (createPayload as { message: string }).message
          : `Booking failed (HTTP ${createRes.status})`;
      return { ok: false, message };
    }

    const { uid, startTime, endTime: calEndTime } =
      extractCalBookingFromResponse(createPayload);

    if (!uid) {
      return {
        ok: false,
        message:
          'Cal.com did not return a booking reference. Try another time or reload.',
      };
    }

    const bookingTime = startTime ?? visit.slotIsoUtc;
    const endTime =
      bookingEndFromDuration(bookingTime, visit.service.durationMins) ??
      calEndTime;

    const completeRes = await fetch('/api/admin/manual-booking/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calBookingUid: uid,
        clientName: trimmedName,
        clientEmail: trimmedEmail,
        clientPhone: phoneDigits,
        serviceName: visit.service.title,
        bookingTime,
        endTime,
        durationMins: visit.service.durationMins,
        eventTypeId: visit.service.eventTypeId,
        ...(notes ? { bookingNotes: notes } : {}),
      }),
    });

    const completePayload: unknown = await completeRes.json().catch(() => null);

    if (!completeRes.ok) {
      const message =
        completePayload &&
        typeof completePayload === 'object' &&
        'message' in completePayload &&
        typeof (completePayload as { message: unknown }).message === 'string'
          ? (completePayload as { message: string }).message
          : `Could not save locally (HTTP ${completeRes.status})`;
      return {
        ok: false,
        message: `Booked on Cal.com (${uid}) but dashboard sync failed: ${message}`,
      };
    }

    return { ok: true };
  }

  async function handleBook() {
    if (pendingVisits.length === 0) return;

    setCompleting(true);
    setError(null);
    setBookingProgress(null);

    const resolved = resolvedClientFields();
    const trimmedFirst = resolved.firstName.trim();
    const trimmedLast = resolved.lastName.trim();
    const trimmedName = joinFullName(trimmedFirst, trimmedLast);
    const trimmedEmail = optionalEmailForApi(resolved.email);
    const parsedPhone = parseClientPhone(resolved.phone);
    if (!parsedPhone) {
      setPhoneTouched(true);
      setError(clientPhoneValidationMessage());
      setCompleting(false);
      return;
    }

    const total = pendingVisits.length;
    let remaining = [...pendingVisits];
    let bookedCount = 0;

    try {
      for (const visit of pendingVisits) {
        setBookingProgress({ current: bookedCount + 1, total });
        const result = await bookOneVisit(
          visit,
          trimmedFirst,
          trimmedLast,
          trimmedName,
          trimmedEmail,
          parsedPhone.digits
        );
        if (!result.ok) {
          setPendingVisits(remaining);
          setError(
            bookedCount === 0
              ? `Booking failed: ${result.message}`
              : `Booked ${bookedCount} of ${total}. Visit ${bookedCount + 1} failed: ${result.message}`
          );
          setCompleting(false);
          setBookingProgress(null);
          return;
        }
        remaining = remaining.filter((row) => row.id !== visit.id);
        bookedCount += 1;
      }

      setPendingVisits([]);
      setLastBooked({
        clientName: trimmedName,
        serviceTitle:
          bookedCount === 1
            ? pendingVisits[0]?.service.title ?? 'Appointment'
            : `${bookedCount} appointments`,
        count: bookedCount,
      });
      setSessionClientLocked(true);
      setClientFields({
        firstName: trimmedFirst,
        lastName: trimmedLast,
        phone: formatPhoneInputDisplay(parsedPhone.digits),
        email: trimmedEmail ?? '',
      });
      setCompleting(false);
      setBookingProgress(null);
      setPhase('success');
      onSuccess();
    } catch (err) {
      setPendingVisits(remaining);
      setError(
        `Booking failed: ${err instanceof Error ? err.message : 'Network error'}`
      );
      setCompleting(false);
      setBookingProgress(null);
    }
  }

  function handleBookAnother() {
    setPhase('wizard');
    setStep(1);
    setSelectedService(null);
    setSelectedSlot(null);
    setBookingNotes('');
    setPendingVisits([]);
    setEditingVisitId(null);
    setBookingProgress(null);
    setError(null);
    setCompleting(false);
  }

  const resolvedForGates = resolvedClientFields();
  const prefilledClientReady =
    !isClientLocked ||
    (resolvedForGates.firstName.trim().length > 0 &&
      resolvedForGates.lastName.trim().length > 0 &&
      parseClientPhone(resolvedForGates.phone) !== null);

  const canAdvanceFromStep1 =
    selectedService !== null &&
    (!isClientLocked || prefilledClientReady) &&
    !catalogLoading &&
    !catalogError;
  const canAdvanceFromStep2 = canAdvanceManualBookingClientStep(
    clientMode,
    clientFields,
    selectedClient
  );

  function handleSelectClient(client: Client | null) {
    if (isClientLocked) return;
    setSelectedClient(client);
    setError(null);
    if (!client) {
      setClientFields(EMPTY_FIELDS);
      return;
    }
    setClientFields(fieldsFromClient(client));
  }

  function handleModeChange(mode: ClientEntryMode) {
    if (isClientLocked) return;
    setClientMode(mode);
    setError(null);
    setSelectedClient(null);
    setClientFields(EMPTY_FIELDS);
    setPhoneTouched(false);
  }

  function goBack() {
    setError(null);
    if (step === 1) {
      if (pendingVisits.length > 0) {
        discardDraft();
        setStep(4);
        return;
      }
      onClose();
      return;
    }
    if (step === 4) {
      if (pendingVisits.length === 1) {
        beginEditVisit(pendingVisits[0], true);
      }
      return;
    }
    if (step === 3 && isClientLocked) {
      setStep(1);
      return;
    }
    setStep((s) => (s - 1) as WizardStep);
  }

  function goForward() {
    setError(null);
    if (step === 3) {
      commitDraftToCart();
      return;
    }
    if (step === 1) {
      if (isClientLocked) {
        if (!prefilledClientReady) {
          setError(
            'This client needs a first name, last name, and phone before booking.'
          );
          return;
        }
        setStep(3);
        if (editingVisitId && !selectedSlot) {
          const visit = pendingVisits.find((row) => row.id === editingVisitId);
          if (visit) setSelectedSlot(visit.slotIsoUtc);
        }
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setPhoneTouched(true);
      const resolved = resolvedClientFields();
      const formatted = formatPhoneInputDisplay(resolved.phone);
      if (formatted !== resolved.phone.trim()) {
        setClientFields((prev) => ({ ...prev, phone: formatted }));
      }
      if (!parseClientPhone(resolved.phone)) return;
      setStep(3);
    }
  }

  const canContinueFromSchedule = selectedSlot !== null && !completing;
  const canBook = pendingVisits.length > 0 && !completing;
  const showingSuccess = phase === 'success';

  const isScheduleStep = !showingSuccess && step === 3;
  const modalWidth = isScheduleStep ? 'max-w-[460px]' : 'max-w-lg';
  const lockedClientName = isClientLocked
    ? joinFullName(
        resolvedForGates.firstName.trim(),
        resolvedForGates.lastName.trim()
      ) ||
      (prefilledClient
        ? clientDisplayName(
            prefilledClient.first_name,
            prefilledClient.last_name
          )
        : '')
    : '';

  const displayName = joinFullName(
    resolvedForGates.firstName.trim(),
    resolvedForGates.lastName.trim()
  );

  const extraOccupiedStartMs = pendingVisits
    .filter((visit) => visit.id !== editingVisitId)
    .map((visit) => epochMsFromIsoUtc(visit.slotIsoUtc))
    .filter((n): n is number => n != null);

  const scheduleSeedDate = (() => {
    if (editingVisitId) {
      const visit = pendingVisits.find((row) => row.id === editingVisitId);
      if (visit) {
        const d = new Date(visit.slotIsoUtc);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
    return seedDate;
  })();

  const showsModeSwitch =
    Boolean(modeSwitch) &&
    !showingSuccess &&
    !selectedService &&
    step !== 4 &&
    !isClientLocked;

  const showsFooterBack = !(step === 4 && pendingVisits.length > 1);
  const footerBackLabel =
    step === 1 && pendingVisits.length === 0 ? 'Cancel' : 'Back';

  const headerTitle = showingSuccess
    ? 'Booked'
    : step === 4
      ? displayName || 'Review visits'
      : (isScheduleStep || step === 2) && selectedService
        ? selectedService.title
        : isClientLocked
          ? lockedClientName || 'Book appointment'
          : 'New appointment';

  const headerSubtitle = showingSuccess
    ? lastBooked
      ? `${lastBooked.count > 1 ? `${lastBooked.count} appointments` : lastBooked.serviceTitle}${lastBooked.clientName ? ` · ${lastBooked.clientName}` : ''}`
      : 'Ready for the next one'
    : step === 4
      ? pendingVisits.length === 1
        ? 'Review 1 visit · then book or add another'
        : `Review ${pendingVisits.length} visits · then book or add another`
      : editingVisitId
        ? step === 1
          ? 'Change service · Edit visit'
          : 'Change date & time · Edit visit'
        : pendingVisits.length > 0
          ? step === 1
            ? lockedClientName
              ? `Choose a service · Add visit for ${lockedClientName}`
              : 'Choose a service · Add visit'
            : 'Pick an open date & time · Add visit'
          : initiallyClientLocked || sessionClientLocked
            ? step === 1
              ? `Choose a service for ${lockedClientName} · Step 1 of 3`
              : 'Pick an open date & time · Step 2 of 3'
            : step === 1
              ? 'Choose a service · Step 1 of 4'
              : step === 2
                ? 'Client details · Step 2 of 4'
                : 'Pick an open date & time · Step 3 of 4';

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-80 flex items-center justify-center bg-stone-900/40 p-3 backdrop-blur-sm sm:p-4"
      onClick={completing ? undefined : onClose}
      role="presentation"
    >
      <div
        className={`flex w-full ${modalWidth} max-h-[min(92vh,680px)] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-[#FAF9F6] text-stone-900 shadow-2xl shadow-stone-900/10`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-booking-title"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-stone-200 bg-[#FAF9F6] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              Manual booking
            </p>
            <h2
              id="manual-booking-title"
              className="mt-0.5 truncate font-serif text-xl leading-tight text-stone-900"
            >
              {headerTitle}
            </h2>
            <p className="mt-0.5 text-xs text-stone-500">{headerSubtitle}</p>
            {showsModeSwitch ? (
              <div className="mt-2.5">{modeSwitch}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={completing}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {(error || catalogError) && !showingSuccess && (
            <div
              role="alert"
              className="mb-3 shrink-0 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {error || catalogError}
            </div>
          )}

          {showingSuccess && lastBooked ? (
            <ManualBookingSuccessPanel
              clientName={lastBooked.clientName}
              serviceTitle={lastBooked.serviceTitle}
              count={lastBooked.count}
              onDone={onClose}
              onBookAnother={handleBookAnother}
            />
          ) : null}

          {!showingSuccess && !completing && step === 1 && (
            <div className="space-y-3">
              {isClientLocked && (
                <p className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600">
                  Booking for{' '}
                  <span className="font-medium text-stone-900">
                    {lockedClientName}
                  </span>
                </p>
              )}
              {isClientLocked &&
                (!resolvedForGates.firstName.trim() ||
                  !resolvedForGates.lastName.trim() ||
                  !parseClientPhone(resolvedForGates.phone)) && (
                  <p
                    className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
                    role="alert"
                  >
                    This client is missing a name or phone. Update their profile
                    before booking.
                  </p>
                )}
              <p className="text-sm text-stone-600">Choose a service</p>
              {catalogLoading ? (
                <div className="flex items-center gap-2 py-10 text-sm text-stone-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading services…
                </div>
              ) : (
                <ManualBookingServicePicker
                  services={services}
                  groupHeaders={groupHeaders}
                  selectedService={selectedService}
                  onSelectService={(service) => {
                    setSelectedService(service);
                    setError(null);
                  }}
                />
              )}
            </div>
          )}

          {!showingSuccess && !completing && step === 2 && !isClientLocked && (
            <ManualBookingClientStep
              mode={clientMode}
              onModeChange={handleModeChange}
              fields={clientFields}
              onFieldsChange={(patch) =>
                setClientFields((prev) => ({ ...prev, ...patch }))
              }
              phoneTouched={phoneTouched}
              onPhoneTouched={() => setPhoneTouched(true)}
              selectedClientId={selectedClient?.id ?? null}
              onSelectClient={handleSelectClient}
            />
          )}

          {!showingSuccess && completing ? (
            <ManualBookingCompletingOverlay progress={bookingProgress} />
          ) : null}

          {!showingSuccess && !completing && step === 3 && selectedService && (
            <div className="space-y-4">
              <ManualBookingSlotPicker
                eventTypeId={selectedService.eventTypeId}
                durationMins={selectedService.durationMins}
                clientName={displayName}
                selectedSlot={selectedSlot}
                onSelectSlot={setSelectedSlot}
                seedDate={scheduleSeedDate}
                seedHour={editingVisitId ? undefined : seedHour}
                extraOccupiedStartMs={extraOccupiedStartMs}
              />
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
                  Booking notes
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-stone-400">
                    Optional
                  </span>
                </span>
                <textarea
                  value={bookingNotes}
                  onChange={(e) => setBookingNotes(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="Anything to remember for this visit"
                  className={NOTES_TEXTAREA_CLASS}
                />
              </label>
            </div>
          )}

          {!showingSuccess && !completing && step === 4 && (
            <div className="space-y-3">
              {displayName ? (
                <p className="text-sm text-stone-600">
                  Visits for{' '}
                  <span className="font-medium text-stone-900">{displayName}</span>
                </p>
              ) : null}
              <ul className="space-y-2">
                {pendingVisits.map((visit) => (
                  <li
                    key={visit.id}
                    className="flex items-start gap-2 rounded-xl border border-stone-200 bg-white px-3 py-3"
                  >
                    <button
                      type="button"
                      onClick={() => beginEditVisit(visit)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="font-serif text-base text-stone-900">
                        {visit.service.title}
                      </p>
                      <p className="mt-0.5 text-sm text-stone-600">
                        {formatVisitDateInStudio(visit.slotIsoUtc)} ·{' '}
                        {formatVisitTimeRange(
                          visit.slotIsoUtc,
                          visit.service.durationMins
                        )}
                      </p>
                      {visit.notes ? (
                        <p className="mt-1 line-clamp-2 text-sm text-stone-500">
                          {visit.notes}
                        </p>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeVisit(visit.id)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
                      aria-label="Remove visit"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={beginAddVisit}
                className={`${BTN_SECONDARY} inline-flex w-full items-center justify-center gap-1.5`}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
          )}
        </div>

        {!showingSuccess && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-200 bg-[#FAF9F6] px-5 py-3">
            {showsFooterBack ? (
              <button
                type="button"
                onClick={goBack}
                disabled={completing}
                className={BTN_SECONDARY}
              >
                {footerBackLabel}
              </button>
            ) : (
              <span />
            )}

            {step === 4 ? (
              <button
                type="button"
                onClick={() => void handleBook()}
                disabled={!canBook}
                className={BTN_PRIMARY}
              >
                {completing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {bookingProgress && bookingProgress.total > 1
                      ? `Booking ${bookingProgress.current} of ${bookingProgress.total}…`
                      : 'Booking…'}
                  </>
                ) : pendingVisits.length > 1 ? (
                  `Book ${pendingVisits.length} appointments`
                ) : (
                  'Book appointment'
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={goForward}
                disabled={
                  (step === 1 && !canAdvanceFromStep1) ||
                  (step === 2 && !canAdvanceFromStep2) ||
                  (step === 3 && !canContinueFromSchedule) ||
                  completing
                }
                className={BTN_PRIMARY}
              >
                Continue
              </button>
            )}
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
