'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import ManualBookingCalSchedule, {
  ManualBookingCompletingOverlay,
} from './ManualBookingCalSchedule';
import type { ManualBookingServiceOption } from './manual-booking-utils';

type WizardStep = 1 | 2 | 3;

interface Props {
  services: ManualBookingServiceOption[];
  onClose: () => void;
  onSuccess: () => void;
}

const INPUT_CLASS =
  'block w-full rounded-md border border-stone-600 bg-stone-800/80 px-3 py-2 text-sm text-stone-50 placeholder:text-stone-500 transition-colors focus:border-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-300/40';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ManualBookingModal({
  services,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');
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

  async function handleCalScheduled(data: {
    calBookingUid: string;
    startTime: string;
    endTime: string | null;
  }) {
    if (!selectedService) return;

    setCompleting(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/manual-booking/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calBookingUid: data.calBookingUid,
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientPhone: clientPhone.trim(),
          serviceName: selectedService.title,
          bookingTime: data.startTime,
          endTime: data.endTime,
        }),
      });

      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          payload &&
          typeof payload === 'object' &&
          'message' in payload &&
          typeof (payload as { message: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : `Booking failed (HTTP ${res.status})`;
        setError(`Booking failed: ${message}`);
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
    clientName.trim().length > 0 &&
    EMAIL_RE.test(clientEmail.trim()) &&
    clientPhone.trim().length > 0;

  const isScheduleStep = step === 3;
  const modalWidth = isScheduleStep ? 'max-w-[420px]' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-950/50 p-3 backdrop-blur-sm sm:p-4"
      onClick={completing ? undefined : onClose}
      role="presentation"
    >
      <div
        className={`flex w-full ${modalWidth} flex-col overflow-hidden rounded-2xl border border-stone-200/90 bg-stone-900/95 text-stone-50 shadow-2xl shadow-stone-950/40 ${
          isScheduleStep ? 'max-h-[92vh]' : 'max-h-[min(88vh,640px)]'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-booking-title"
      >
        <header
          className={`flex shrink-0 items-start justify-between gap-3 border-b border-stone-700/80 ${
            isScheduleStep ? 'px-4 py-3' : 'px-6 py-5'
          }`}
        >
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
              Manual booking
            </p>
            <h2
              id="manual-booking-title"
              className={`font-serif leading-tight text-stone-50 ${
                isScheduleStep
                  ? 'mt-0.5 truncate text-xl'
                  : 'mt-1 text-2xl'
              }`}
            >
              {isScheduleStep && selectedService
                ? selectedService.title
                : 'New appointment'}
            </h2>
            <p className="mt-0.5 text-xs text-stone-400">
              {isScheduleStep
                ? 'Pick an open date & time · Step 3 of 3'
                : `Step ${step} of 3`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={completing}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          className={
            isScheduleStep
              ? 'shrink-0 overflow-hidden px-3 pb-2 pt-1'
              : 'flex-1 overflow-y-auto px-6 py-5'
          }
        >
          {error && (
            <div
              role="alert"
              className={`shrink-0 rounded-md border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-200 ${
                isScheduleStep ? 'mb-2' : 'mb-4'
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
                Next you&apos;ll pick an open slot in Cal.com — these details
                are sent to Cal when you confirm the time.
              </p>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                  Name
                </span>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  autoComplete="name"
                  className={INPUT_CLASS}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                  Email
                </span>
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  autoComplete="email"
                  className={INPUT_CLASS}
                />
              </label>
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
            </div>
          )}

          {step === 3 && selectedService && (
            <>
              {completing ? (
                <ManualBookingCompletingOverlay />
              ) : (
                <ManualBookingCalSchedule
                  serviceSlug={selectedService.slug}
                  clientName={clientName.trim()}
                  clientEmail={clientEmail.trim()}
                  clientPhone={clientPhone.trim()}
                  onScheduled={(data) => void handleCalScheduled(data)}
                  onError={setError}
                />
              )}
            </>
          )}
        </div>

        <footer
          className={`flex shrink-0 items-center justify-between gap-3 border-t border-stone-700/80 ${
            isScheduleStep ? 'px-4 py-2.5' : 'px-6 py-4'
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
            className="rounded-full border border-stone-600 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-300 transition-colors hover:border-stone-400 hover:text-stone-100 disabled:opacity-50"
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
            <p className="text-[11px] text-stone-500">
              Confirm in Cal to book · no checkout
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
