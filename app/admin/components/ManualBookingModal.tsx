'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import ManualBookingSlotPicker from './ManualBookingSlotPicker';
import type { ManualBookingServiceOption } from './manual-booking-utils';
import {
  extractCalBookingFromResponse,
  joinFullName,
  slotToStudioLocalStart,
} from './manual-booking-utils';

type WizardStep = 1 | 2 | 3;

interface Props {
  services: ManualBookingServiceOption[];
  onClose: () => void;
  onSuccess: () => void;
}

const INPUT_CLASS =
  'block w-full rounded-md border border-stone-600 bg-stone-800/80 px-3 py-2 text-sm text-stone-50 placeholder:text-stone-500 transition-colors focus:border-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-300/40';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optionalEmailForApi(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
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

export default function ManualBookingModal({
  services,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');
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

    const trimmedFirst = clientFirstName.trim();
    const trimmedLast = clientLastName.trim();
    const trimmedName = joinFullName(trimmedFirst, trimmedLast);
    const trimmedEmail = optionalEmailForApi(clientEmail);
    if (clientEmail.trim().length > 0 && !trimmedEmail) {
      setError('Enter a valid email address or leave email blank.');
      setCompleting(false);
      return;
    }
    const trimmedPhone = clientPhone.trim();

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
          clientPhone: trimmedPhone,
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

      const { uid, startTime, endTime } =
        extractCalBookingFromResponse(createPayload);

      if (!uid) {
        setError(
          'Cal.com did not return a booking reference. Try another time or reload.'
        );
        setCompleting(false);
        return;
      }

      const completeRes = await fetch('/api/admin/manual-booking/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calBookingUid: uid,
          clientName: trimmedName,
          clientEmail: trimmedEmail,
          clientPhone: trimmedPhone,
          serviceName: selectedService.title,
          bookingTime: startTime ?? selectedSlot,
          endTime,
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
  const canAdvanceFromStep2 =
    clientFirstName.trim().length > 0 &&
    clientLastName.trim().length > 0 &&
    clientPhone.replace(/\D/g, '').length > 0 &&
    (clientEmail.trim().length === 0 || EMAIL_RE.test(clientEmail.trim()));
  const canBook = selectedSlot !== null && !completing;

  const isScheduleStep = step === 3;
  const modalWidth = isScheduleStep ? 'max-w-[460px]' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-950/50 p-3 backdrop-blur-sm sm:p-4"
      onClick={completing ? undefined : onClose}
      role="presentation"
    >
      <div
        className={`flex w-full ${modalWidth} flex-col overflow-hidden rounded-2xl shadow-2xl ${
          isScheduleStep
            ? 'border border-stone-200 bg-[#FAF9F6] text-stone-900'
            : 'border border-stone-200/90 bg-stone-900/95 text-stone-50 shadow-stone-950/40'
        } ${isScheduleStep ? 'max-h-[min(92vh,680px)]' : 'max-h-[min(88vh,640px)]'}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-booking-title"
      >
        <header
          className={`flex shrink-0 items-start justify-between gap-3 border-b ${
            isScheduleStep
              ? 'border-stone-200 bg-[#FAF9F6] px-5 py-4'
              : 'border-stone-700/80 px-6 py-5'
          }`}
        >
          <div className="min-w-0">
            <p
              className={`text-[10px] font-medium uppercase tracking-[0.28em] ${
                isScheduleStep ? 'text-stone-500' : 'text-stone-400'
              }`}
            >
              Manual booking
            </p>
            <h2
              id="manual-booking-title"
              className={`font-serif leading-tight ${
                isScheduleStep
                  ? 'mt-0.5 truncate text-xl text-stone-900'
                  : 'mt-1 text-2xl text-stone-50'
              }`}
            >
              {isScheduleStep && selectedService
                ? selectedService.title
                : 'New appointment'}
            </h2>
            <p
              className={`mt-0.5 text-xs ${
                isScheduleStep ? 'text-stone-500' : 'text-stone-400'
              }`}
            >
              {isScheduleStep
                ? 'Pick an open date & time · Step 3 of 3'
                : `Step ${step} of 3`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={completing}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
              isScheduleStep
                ? 'text-stone-500 hover:bg-stone-200 hover:text-stone-900'
                : 'text-stone-400 hover:bg-stone-800 hover:text-stone-100'
            }`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          className={
            isScheduleStep
              ? 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
              : 'flex-1 overflow-y-auto px-6 py-5'
          }
        >
          {error && (
            <div
              role="alert"
              className={`shrink-0 rounded-md border px-3 py-2 text-sm ${
                isScheduleStep
                  ? 'mb-3 border-rose-200 bg-rose-50 text-rose-800'
                  : 'mb-4 border-rose-500/40 bg-rose-950/50 text-rose-200'
              }`}
            >
              {error}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-stone-300">Choose a service</p>
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {services.length === 0 ? (
                  <li className="text-sm text-stone-400">
                    No bookable services found. Add services in the Services
                    tab first.
                  </li>
                ) : (
                  services.map((service) => {
                    const active = selectedService?.slug === service.slug;
                    return (
                      <li key={service.slug}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedService(service);
                            setError(null);
                          }}
                          className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                            active
                              ? 'border-stone-100 bg-stone-800 ring-1 ring-stone-200/80'
                              : 'border-stone-700 bg-stone-800/40 hover:border-stone-500 hover:bg-stone-800/70'
                          }`}
                        >
                          <span className="block font-serif text-base text-stone-50">
                            {service.title}
                          </span>
                          {service.durationMins != null && (
                            <span className="mt-0.5 block text-xs text-stone-400">
                              {service.durationMins} min
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-stone-300">Client details</p>
              <p className="text-xs text-stone-500">
                Phone is required and identifies the client in your CRM. Email
                is optional — you can add it later from the client profile.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                    First name
                  </span>
                  <input
                    type="text"
                    value={clientFirstName}
                    onChange={(e) => setClientFirstName(e.target.value)}
                    autoComplete="given-name"
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                    Last name
                  </span>
                  <input
                    type="text"
                    value={clientLastName}
                    onChange={(e) => setClientLastName(e.target.value)}
                    autoComplete="family-name"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                  Phone
                </span>
                <input
                  type="tel"
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  autoComplete="tel"
                  className={INPUT_CLASS}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                  Email <span className="normal-case tracking-normal text-stone-500">(optional)</span>
                </span>
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  autoComplete="email"
                  className={INPUT_CLASS}
                  placeholder="Leave blank if unknown"
                />
              </label>
            </div>
          )}

          {step === 3 && selectedService && (
            <>
              {completing ? (
                <ManualBookingCompletingOverlay />
              ) : (
                <ManualBookingSlotPicker
                  eventTypeId={selectedService.eventTypeId}
                  clientName={joinFullName(
                    clientFirstName.trim(),
                    clientLastName.trim()
                  )}
                  selectedSlot={selectedSlot}
                  onSelectSlot={setSelectedSlot}
                />
              )}
            </>
          )}
        </div>

        <footer
          className={`flex shrink-0 items-center justify-between gap-3 border-t ${
            isScheduleStep
              ? 'border-stone-200 bg-[#FAF9F6] px-5 py-3'
              : 'border-stone-700/80 px-6 py-4'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setError(null);
              if (step === 1) onClose();
              else setStep((s) => (s - 1) as WizardStep);
            }}
            disabled={completing}
            className={`rounded-full border px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] transition-colors disabled:opacity-50 ${
              isScheduleStep
                ? 'border-stone-300 text-stone-600 hover:border-stone-900 hover:text-stone-900'
                : 'border-stone-600 text-stone-300 hover:border-stone-400 hover:text-stone-100'
            }`}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep((s) => (s + 1) as WizardStep);
              }}
              disabled={
                (step === 1 && !canAdvanceFromStep1) ||
                (step === 2 && !canAdvanceFromStep2) ||
                completing
              }
              className="inline-flex items-center gap-2 rounded-full border border-stone-100 bg-stone-100 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-900 transition-colors hover:bg-white disabled:opacity-50"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleBook()}
              disabled={!canBook}
              className="inline-flex items-center gap-2 rounded-full border border-stone-900 bg-stone-900 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-50 transition-colors hover:bg-stone-800 disabled:opacity-50"
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
