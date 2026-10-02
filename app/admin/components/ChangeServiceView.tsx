'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Loader2, X } from 'lucide-react';

import { clientDisplayName } from '../helpers';
import type { Appointment } from '../types';
import AdminSendSmsCheckbox from './AdminSendSmsCheckbox';
import ManualBookingServicePicker from './ManualBookingServicePicker';
import type {
  ManualBookingServiceGroupHeader,
  ManualBookingServiceOption,
} from './manual-booking-utils';

type Step = 'service' | 'confirm';

const BTN_SECONDARY =
  'rounded-full border border-stone-200 bg-white px-4 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50';

const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-stone-900 bg-stone-900 px-4 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-stone-50 transition-colors hover:bg-stone-800 disabled:border-stone-200 disabled:bg-stone-300 disabled:text-stone-500';

function formatMenuPrice(price: number): string {
  if (Number.isInteger(price)) return `$${price}`;
  return `$${price.toFixed(2)}`;
}

/**
 * Swap the catalogue service on an unpaid upcoming visit.
 * The start time stays; confirm shows the new name, length, and price.
 */
export default function ChangeServiceView({
  appointment,
  initialServices = [],
  initialGroupHeaders = [],
  onBack,
  onClose,
}: {
  appointment: Appointment;
  initialServices?: ManualBookingServiceOption[];
  initialGroupHeaders?: ManualBookingServiceGroupHeader[];
  onBack: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const clientName = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  );
  const currentSlug = appointment.service_slug;

  const [services, setServices] = useState(initialServices);
  const [groupHeaders, setGroupHeaders] = useState(initialGroupHeaders);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(null);
  const [step, setStep] = useState<Step>('service');
  const [sendSms, setSendSms] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(
    initialServices.length === 0
  );
  const [completing, setCompleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isCurrent =
    selectedService != null &&
    currentSlug != null &&
    selectedService.slug === currentSlug;

  useEffect(() => {
    if (initialServices.length > 0) return;
    let cancelled = false;

    void (async () => {
      setBootstrapping(true);
      try {
        const res = await fetch('/api/admin/manual-booking/services');
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            payload &&
              typeof payload === 'object' &&
              'message' in payload &&
              typeof (payload as { message: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : `Could not load services (HTTP ${res.status})`
          );
        }
        const nextServices =
          payload &&
          typeof payload === 'object' &&
          'services' in payload &&
          Array.isArray((payload as { services: unknown }).services)
            ? (payload as { services: ManualBookingServiceOption[] }).services
            : [];
        const nextHeaders =
          payload &&
          typeof payload === 'object' &&
          'groupHeaders' in payload &&
          Array.isArray((payload as { groupHeaders: unknown }).groupHeaders)
            ? (payload as { groupHeaders: ManualBookingServiceGroupHeader[] })
                .groupHeaders
            : [];
        if (cancelled) return;
        setServices(nextServices);
        setGroupHeaders(nextHeaders);
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Could not load services'
          );
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialServices.length]);

  async function confirm() {
    if (!selectedService || isCurrent || completing) return;
    setCompleting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/admin/appointments/${encodeURIComponent(appointment.id)}/change-service`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventTypeId: selectedService.eventTypeId,
            send_sms: sendSms,
          }),
        }
      );
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          payload &&
          typeof payload === 'object' &&
          'message' in payload &&
          typeof (payload as { message: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : `Could not change this service (HTTP ${res.status})`;
        setErrorMessage(message);
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not change this service'
      );
    } finally {
      setCompleting(false);
    }
  }

  const headerTitle =
    step === 'confirm' && selectedService
      ? selectedService.title
      : 'Change service';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-[#FAF9F6] px-4 py-3 sm:px-6 sm:py-4">
        <button
          type="button"
          onClick={() => {
            if (step === 'confirm') {
              setStep('service');
              setErrorMessage(null);
              return;
            }
            onBack();
          }}
          disabled={completing}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {step === 'confirm' ? 'Service' : 'Back'}
        </button>
        <div className="text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
            Change service
          </p>
          <h2 className="font-serif text-lg text-stone-900 sm:text-xl">
            {headerTitle}
          </h2>
        </div>
        <button
          type="button"
          onClick={onBack}
          disabled={completing}
          aria-label="Close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto bg-[#FAF9F6] px-4 py-4 sm:px-6">
        {completing ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Loader2 className="mb-4 h-8 w-8 animate-spin text-stone-400" />
            <p className="font-serif text-lg text-stone-900">
              Updating the service…
            </p>
            <p className="mt-1 text-sm text-stone-500">
              The time stays the same.
            </p>
          </div>
        ) : bootstrapping ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Loader2 className="mb-4 h-8 w-8 animate-spin text-stone-400" />
            <p className="font-serif text-lg text-stone-900">Loading services</p>
          </div>
        ) : (
          <div className="space-y-4">
            {errorMessage ? (
              <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm leading-relaxed text-amber-950">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{errorMessage}</p>
              </div>
            ) : null}

            {step === 'service' ? (
              <div className="space-y-3">
                <p className="text-sm text-stone-600">
                  Choose the new service
                  {clientName !== 'Unknown client' ? (
                    <>
                      {' '}
                      for{' '}
                      <span className="font-medium text-stone-900">
                        {clientName}
                      </span>
                    </>
                  ) : null}
                  . The start time stays the same.
                </p>
                <ManualBookingServicePicker
                  services={services}
                  groupHeaders={groupHeaders}
                  selectedService={selectedService}
                  currentSlug={currentSlug}
                  onSelectService={(service) => {
                    setSelectedService(service);
                    setErrorMessage(null);
                  }}
                />
                {isCurrent ? (
                  <p className="text-sm text-stone-500">
                    This visit is already booked as that service.
                  </p>
                ) : null}
              </div>
            ) : selectedService ? (
              <div className="space-y-4">
                <p className="text-sm text-stone-600">
                  The start time stays the same.
                </p>
                <div className="rounded-xl border border-stone-200 bg-white px-4 py-4">
                  <p className="font-serif text-xl text-stone-900">
                    {selectedService.title}
                  </p>
                  <p className="mt-1 text-sm text-stone-600">
                    {selectedService.durationMins != null
                      ? `${selectedService.durationMins} min`
                      : 'Duration from the catalogue'}
                    {typeof selectedService.price === 'number'
                      ? ` · ${formatMenuPrice(selectedService.price)}`
                      : ''}
                  </p>
                </div>
                <AdminSendSmsCheckbox
                  checked={sendSms}
                  onChange={setSendSms}
                  disabled={completing}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!completing && !bootstrapping ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-200 bg-[#FAF9F6] px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => {
              if (step === 'confirm') {
                setStep('service');
                setErrorMessage(null);
                return;
              }
              onBack();
            }}
            className={BTN_SECONDARY}
          >
            {step === 'confirm' ? 'Back' : 'Cancel'}
          </button>
          {step === 'service' ? (
            <button
              type="button"
              disabled={!selectedService || isCurrent}
              onClick={() => {
                setErrorMessage(null);
                setStep('confirm');
              }}
              className={BTN_PRIMARY}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              disabled={!selectedService || isCurrent}
              onClick={() => {
                void confirm();
              }}
              className={BTN_PRIMARY}
            >
              Confirm
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
