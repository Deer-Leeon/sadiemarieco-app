'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

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
  extractCalBookingFromResponse,
  joinFullName,
  slotToStudioLocalStart,
} from './manual-booking-utils';

type WizardStep = 1 | 2 | 3;

interface Props {
  /** When omitted, the modal loads the catalogue from the API. */
  services?: ManualBookingServiceOption[];
  groupHeaders?: ManualBookingServiceGroupHeader[];
  /**
   * When set, skips the client-details step — the booking is for this
   * CRM client (service → schedule only).
   */
  prefilledClient?: Client;
  onClose: () => void;
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

function ManualBookingCompletingOverlay() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Loader2 className="h-7 w-7 animate-spin text-stone-400" />
      <p className="font-serif text-lg text-stone-900">Saving appointment…</p>
      <p className="text-sm text-stone-500">Updating Cal.com and your calendar</p>
    </div>
  );
}

const EMPTY_FIELDS: ManualBookingClientFields = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
};

export default function ManualBookingModal({
  services: servicesProp,
  groupHeaders: groupHeadersProp,
  prefilledClient,
  onClose,
  onSuccess,
}: Props) {
  const clientLocked = Boolean(prefilledClient);

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
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [clientMode, setClientMode] = useState<ClientEntryMode>('existing');
  const [clientFields, setClientFields] = useState<ManualBookingClientFields>(
    () => (prefilledClient ? fieldsFromClient(prefilledClient) : EMPTY_FIELDS)
  );
  const [selectedClient, setSelectedClient] = useState<Client | null>(
    prefilledClient ?? null
  );
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

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
    if (step !== 3) {
      setSelectedSlot(null);
    }
  }, [step]);

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

  async function handleBook() {
    if (!selectedService || !selectedSlot) return;

    setCompleting(true);
    setError(null);

    let start: string;
    try {
      start = slotToStudioLocalStart(selectedSlot);
    } catch {
      setError('Selected time is invalid. Please pick another slot.');
      setCompleting(false);
      return;
    }

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

    try {
      const createRes = await fetch('/api/admin/manual-booking/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTypeId: selectedService.eventTypeId,
          start,
          clientFirstName: trimmedFirst,
          clientLastName: trimmedLast,
          clientName: trimmedName,
          clientEmail: trimmedEmail,
          clientPhone: parsedPhone.digits,
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
        setError(`Booking failed: ${message}`);
        setCompleting(false);
        return;
      }

      const { uid, startTime, endTime: calEndTime } =
        extractCalBookingFromResponse(createPayload);

      if (!uid) {
        setError(
          'Cal.com did not return a booking reference. Try another time or reload.'
        );
        setCompleting(false);
        return;
      }

      const bookingTime = startTime ?? selectedSlot;
      const endTime =
        bookingEndFromDuration(bookingTime, selectedService.durationMins) ??
        calEndTime;

      const completeRes = await fetch('/api/admin/manual-booking/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calBookingUid: uid,
          clientName: trimmedName,
          clientEmail: trimmedEmail,
          clientPhone: parsedPhone.digits,
          serviceName: selectedService.title,
          bookingTime,
          endTime,
          durationMins: selectedService.durationMins,
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
        setError(
          `Booked on Cal.com (${uid}) but dashboard sync failed: ${message}`
        );
        setCompleting(false);
        return;
      }

      onSuccess();
    } catch (err) {
      setError(
        `Booking failed: ${err instanceof Error ? err.message : 'Network error'}`
      );
      setCompleting(false);
    }
  }

  const resolvedForGates = resolvedClientFields();
  const prefilledClientReady =
    !clientLocked ||
    (resolvedForGates.firstName.trim().length > 0 &&
      resolvedForGates.lastName.trim().length > 0 &&
      parseClientPhone(resolvedForGates.phone) !== null);

  const canAdvanceFromStep1 =
    selectedService !== null &&
    (!clientLocked || prefilledClientReady) &&
    !catalogLoading &&
    !catalogError;
  const canAdvanceFromStep2 = canAdvanceManualBookingClientStep(
    clientMode,
    clientFields,
    selectedClient
  );

  function handleSelectClient(client: Client | null) {
    if (clientLocked) return;
    setSelectedClient(client);
    setError(null);
    if (!client) {
      setClientFields(EMPTY_FIELDS);
      return;
    }
    setClientFields(fieldsFromClient(client));
  }

  function handleModeChange(mode: ClientEntryMode) {
    if (clientLocked) return;
    setClientMode(mode);
    setError(null);
    setSelectedClient(null);
    setClientFields(EMPTY_FIELDS);
    setPhoneTouched(false);
  }

  function goBack() {
    setError(null);
    if (step === 1) {
      onClose();
      return;
    }
    if (step === 3 && clientLocked) {
      setStep(1);
      return;
    }
    setStep((s) => (s - 1) as WizardStep);
  }

  function goForward() {
    setError(null);
    if (step === 1) {
      if (clientLocked) {
        if (!prefilledClientReady) {
          setError(
            'This client needs a first name, last name, and phone before booking.'
          );
          return;
        }
        setStep(3);
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

  const canBook = selectedSlot !== null && !completing;

  const isScheduleStep = step === 3;
  const modalWidth = isScheduleStep ? 'max-w-[460px]' : 'max-w-lg';
  const lockedClientName = prefilledClient
    ? clientDisplayName(prefilledClient.first_name, prefilledClient.last_name)
    : '';

  const headerTitle =
    (isScheduleStep || step === 2) && selectedService
      ? selectedService.title
      : clientLocked
        ? lockedClientName || 'Book appointment'
        : 'New appointment';

  const headerSubtitle = clientLocked
    ? step === 1
      ? `Choose a service for ${lockedClientName} · Step 1 of 2`
      : `Pick an open date & time · Step 2 of 2`
    : step === 1
      ? 'Choose a service · Step 1 of 3'
      : step === 2
        ? 'Client details · Step 2 of 3'
        : 'Pick an open date & time · Step 3 of 3';

  const displayName = joinFullName(
    resolvedForGates.firstName.trim(),
    resolvedForGates.lastName.trim()
  );

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
          {(error || catalogError) && (
            <div
              role="alert"
              className="mb-3 shrink-0 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {error || catalogError}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              {clientLocked && (
                <p className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600">
                  Booking for{' '}
                  <span className="font-medium text-stone-900">
                    {lockedClientName}
                  </span>
                </p>
              )}
              {clientLocked &&
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

          {step === 2 && !clientLocked && (
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

          {step === 3 && selectedService && (
            <>
              {completing ? (
                <ManualBookingCompletingOverlay />
              ) : (
                <ManualBookingSlotPicker
                  eventTypeId={selectedService.eventTypeId}
                  durationMins={selectedService.durationMins}
                  clientName={displayName}
                  selectedSlot={selectedSlot}
                  onSelectSlot={setSelectedSlot}
                />
              )}
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-200 bg-[#FAF9F6] px-5 py-3">
          <button
            type="button"
            onClick={goBack}
            disabled={completing}
            className={BTN_SECONDARY}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button
              type="button"
              onClick={goForward}
              disabled={
                (step === 1 && !canAdvanceFromStep1) ||
                (step === 2 && !canAdvanceFromStep2) ||
                completing
              }
              className={BTN_PRIMARY}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleBook()}
              disabled={!canBook}
              className={BTN_PRIMARY}
            >
              {completing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Booking…
                </>
              ) : (
                'Book appointment'
              )}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
