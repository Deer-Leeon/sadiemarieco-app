'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import {
  formatSlotInStudioTime,
  parseCalSlotTimes,
  slotToStudioLocalStart,
  todayInStudio,
  type ManualBookingServiceOption,
} from './manual-booking-utils';

type WizardStep = 1 | 2 | 3;

interface Props {
  services: ManualBookingServiceOption[];
  onClose: () => void;
  onSuccess: () => void;
}

const INPUT_CLASS =
  'block w-full rounded-md border border-stone-600 bg-stone-800/80 px-3 py-2 text-sm text-stone-50 placeholder:text-stone-500 transition-colors focus:border-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-300/40';

export default function ManualBookingModal({
  services,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [date, setDate] = useState(todayInStudio);
  const [slots, setSlots] = useState<string[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
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
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const loadSlots = useCallback(async (eventTypeId: number, day: string) => {
    setSlotsLoading(true);
    setError(null);
    setSlots([]);
    setSelectedSlot(null);

    try {
      const params = new URLSearchParams({
        eventTypeId: String(eventTypeId),
        date: day,
      });
      const res = await fetch(`/api/admin/manual-booking/slots?${params}`);
      const data: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          data &&
          typeof data === 'object' &&
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : `Could not load slots (HTTP ${res.status})`;
        setError(message);
        return;
      }

      const times = parseCalSlotTimes(data, day);
      setSlots(times);
      if (times.length === 0) {
        setError('No open times on this date. Try another day.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load slots');
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step !== 2 || !selectedService || !date) return;
    void loadSlots(selectedService.eventTypeId, date);
  }, [step, selectedService, date, loadSlots]);

  async function handleSubmit() {
    if (!selectedService || !selectedSlot) return;

    setSubmitting(true);
    setError(null);

    let start: string;
    try {
      start = slotToStudioLocalStart(selectedSlot);
    } catch {
      setError('Selected time is invalid. Please pick another slot.');
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch('/api/admin/manual-booking/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTypeId: selectedService.eventTypeId,
          start,
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientPhone: clientPhone.trim(),
        }),
      });

      const data: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          data &&
          typeof data === 'object' &&
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : `Booking failed (HTTP ${res.status})`;
        setError(`Booking failed: ${message}`);
        return;
      }

      onSuccess();
    } catch (err) {
      setError(
        `Booking failed: ${err instanceof Error ? err.message : 'Network error'}`
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canAdvanceFromStep1 = selectedService !== null;
  const canAdvanceFromStep2 =
    selectedSlot !== null && !slotsLoading && slots.length > 0;
  const canSubmit =
    clientName.trim().length > 0 &&
    clientEmail.trim().length > 0 &&
    clientPhone.trim().length > 0 &&
    !submitting;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-950/50 p-4 backdrop-blur-sm"
      onClick={submitting ? undefined : onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-stone-200/90 bg-stone-900/95 text-stone-50 shadow-2xl shadow-stone-950/40"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-booking-title"
      >
        <header className="flex items-start justify-between gap-4 border-b border-stone-700/80 px-6 py-5">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
              Manual booking
            </p>
            <h2
              id="manual-booking-title"
              className="mt-1 font-serif text-2xl leading-tight text-stone-50"
            >
              New appointment
            </h2>
            <p className="mt-1 text-xs text-stone-400">Step {step} of 3</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-200"
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

          {step === 2 && selectedService && (
            <div className="space-y-4">
              <p className="text-sm text-stone-300">
                Schedule ·{' '}
                <span className="text-stone-100">{selectedService.title}</span>
              </p>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                  Date
                </span>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={INPUT_CLASS}
                />
              </label>

              {slotsLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading available times…
                </div>
              ) : slots.length > 0 ? (
                <div>
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                    Available times (Mountain)
                  </p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {slots.map((slot) => {
                      const active = selectedSlot === slot;
                      return (
                        <button
                          key={slot}
                          type="button"
                          onClick={() => {
                            setSelectedSlot(slot);
                            setError(null);
                          }}
                          className={`rounded-md border px-2 py-2 text-sm transition-colors ${
                            active
                              ? 'border-stone-100 bg-stone-100 text-stone-900'
                              : 'border-stone-600 bg-stone-800/60 text-stone-100 hover:border-stone-400 hover:bg-stone-800'
                          }`}
                        >
                          {formatSlotInStudioTime(slot)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-stone-300">Client details</p>
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
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-stone-700/80 px-6 py-4">
          <button
            type="button"
            onClick={() => {
              setError(null);
              if (step === 1) onClose();
              else setStep((s) => (s - 1) as WizardStep);
            }}
            disabled={submitting}
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
                submitting
              }
              className="inline-flex items-center gap-2 rounded-full border border-stone-100 bg-stone-100 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-900 transition-colors hover:bg-white disabled:opacity-50"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-full border border-stone-100 bg-stone-100 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-900 transition-colors hover:bg-white disabled:opacity-50"
            >
              {submitting ? (
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
