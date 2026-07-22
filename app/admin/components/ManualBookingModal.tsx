'use client';

import { useEffect, useState } from 'react';
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

import type { Client } from '../types';
import {
  bookingEndFromDuration,
  extractCalBookingFromResponse,
  joinFullName,
  slotToStudioLocalStart,
} from './manual-booking-utils';

type WizardStep = 1 | 2 | 3;

interface Props {
  services: ManualBookingServiceOption[];
  groupHeaders: ManualBookingServiceGroupHeader[];
  onClose: () => void;
  onSuccess: () => void;
}

const BTN_SECONDARY =
  'rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 disabled:opacity-50';

const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-full border border-stone-600 bg-stone-700 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition-colors hover:border-stone-700 hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-300 disabled:border-stone-200 disabled:bg-stone-300 disabled:text-stone-500';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredEmailForApi(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || isPlaceholderClientEmail(trimmed)) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
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
  services,
  groupHeaders,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [clientMode, setClientMode] = useState<ClientEntryMode>('existing');
  const [clientFields, setClientFields] =
    useState<ManualBookingClientFields>(EMPTY_FIELDS);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const trimmedEmail = requiredEmailForApi(resolved.email);
    if (!trimmedEmail) {
      setError('Enter a valid email address.');
      setCompleting(false);
      return;
    }
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

  const canAdvanceFromStep1 = selectedService !== null;
  const canAdvanceFromStep2 = canAdvanceManualBookingClientStep(
    clientMode,
    clientFields,
    selectedClient
  );

  function handleSelectClient(client: Client | null) {
    setSelectedClient(client);
    setError(null);
    if (!client) {
      setClientFields(EMPTY_FIELDS);
      return;
    }
    setClientFields({
      firstName: client.first_name?.trim() || '',
      lastName: client.last_name?.trim() || '',
      phone: client.phone ? formatPhoneInputDisplay(client.phone) : '',
      email:
        client.email && !isPlaceholderClientEmail(client.email)
          ? client.email.trim()
          : '',
    });
  }

  function handleModeChange(mode: ClientEntryMode) {
    setClientMode(mode);
    setError(null);
    setSelectedClient(null);
    setClientFields(EMPTY_FIELDS);
    setPhoneTouched(false);
  }

  const canBook = selectedSlot !== null && !completing;

  const isScheduleStep = step === 3;
  const modalWidth = isScheduleStep ? 'max-w-[460px]' : 'max-w-lg';
  const headerTitle =
    (isScheduleStep || step === 2) && selectedService
      ? selectedService.title
      : 'New appointment';
  const headerSubtitle =
    step === 1
      ? 'Choose a service · Step 1 of 3'
      : step === 2
        ? 'Client details · Step 2 of 3'
        : 'Pick an open date & time · Step 3 of 3';

  const resolvedForDisplay = resolvedClientFields();
  const displayName = joinFullName(
    resolvedForDisplay.firstName.trim(),
    resolvedForDisplay.lastName.trim()
  );

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/40 p-3 backdrop-blur-sm sm:p-4"
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
          {error && (
            <div
              role="alert"
              className="mb-3 shrink-0 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {error}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-stone-600">Choose a service</p>
              <ManualBookingServicePicker
                services={services}
                groupHeaders={groupHeaders}
                selectedService={selectedService}
                onSelectService={(service) => {
                  setSelectedService(service);
                  setError(null);
                }}
              />
            </div>
          )}

          {step === 2 && (
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
            onClick={() => {
              setError(null);
              if (step === 1) onClose();
              else setStep((s) => (s - 1) as WizardStep);
            }}
            disabled={completing}
            className={BTN_SECONDARY}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                if (step === 2) {
                  setPhoneTouched(true);
                  const resolved = resolvedClientFields();
                  const formatted = formatPhoneInputDisplay(resolved.phone);
                  if (formatted !== resolved.phone.trim()) {
                    setClientFields((prev) => ({ ...prev, phone: formatted }));
                  }
                  if (!parseClientPhone(resolved.phone)) return;
                }
                setStep((s) => (s + 1) as WizardStep);
              }}
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
    </div>
  );
}
