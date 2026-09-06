'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseISO } from 'date-fns';
import { AlertCircle, ArrowLeft, Loader2, X } from 'lucide-react';

import { clientDisplayName } from '../helpers';
import type { Appointment } from '../types';
import AdminSendSmsCheckbox from './AdminSendSmsCheckbox';
import ManualBookingServicePicker from './ManualBookingServicePicker';
import ManualBookingSlotPicker from './ManualBookingSlotPicker';
import {
  slotToStudioLocalStart,
  type ManualBookingServiceGroupHeader,
  type ManualBookingServiceOption,
} from './manual-booking-utils';

type Step = 'service' | 'schedule';

const BTN_SECONDARY =
  'rounded-full border border-stone-200 bg-white px-4 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50';

const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-stone-900 bg-stone-900 px-4 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-stone-50 transition-colors hover:bg-stone-800 disabled:border-stone-200 disabled:bg-stone-300 disabled:text-stone-500';

function findServiceBySlug(
  services: ManualBookingServiceOption[],
  slug: string | null
): ManualBookingServiceOption | null {
  if (!slug) return null;
  return services.find((service) => service.slug === slug) ?? null;
}

function seedDateFromAppointment(appointment: Appointment): Date | undefined {
  if (!appointment.booking_time) return undefined;
  const parsed = parseISO(appointment.booking_time);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Admin god-mode reschedule — same slot picker as New booking
 * (any future day, amber busy slots still tappable).
 */
export default function AdminRescheduleView({
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

  const [services, setServices] = useState(initialServices);
  const [groupHeaders, setGroupHeaders] = useState(initialGroupHeaders);
  const [selectedService, setSelectedService] =
    useState<ManualBookingServiceOption | null>(() =>
      findServiceBySlug(initialServices, appointment.service_slug)
    );
  const [needsServicePick, setNeedsServicePick] = useState(
    () => findServiceBySlug(initialServices, appointment.service_slug) == null
  );
  const [step, setStep] = useState<Step>(() =>
    findServiceBySlug(initialServices, appointment.service_slug)
      ? 'schedule'
      : 'service'
  );
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [sendSms, setSendSms] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(
    initialServices.length === 0
  );
  const [completing, setCompleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
            ? ((payload as { services: ManualBookingServiceOption[] }).services)
            : [];
        const nextHeaders =
          payload &&
          typeof payload === 'object' &&
          'groupHeaders' in payload &&
          Array.isArray((payload as { groupHeaders: unknown }).groupHeaders)
            ? ((payload as { groupHeaders: ManualBookingServiceGroupHeader[] })
                .groupHeaders)
            : [];
        if (cancelled) return;
        setServices(nextServices);
        setGroupHeaders(nextHeaders);
        const match = findServiceBySlug(nextServices, appointment.service_slug);
        setSelectedService(match);
        setNeedsServicePick(match == null);
        setStep(match ? 'schedule' : 'service');
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
  }, [appointment.service_slug, initialServices.length]);

  const headerTitle =
    step === 'schedule' && selectedService
      ? selectedService.title
      : 'Move appointment';

  const canConfirm = Boolean(selectedService && selectedSlot) && !completing;

  async function confirm() {
    if (!selectedService || !selectedSlot || completing) return;
    let start: string;
    try {
      start = slotToStudioLocalStart(selectedSlot);
    } catch {
      setErrorMessage('Selected time is invalid. Please pick another slot.');
      return;
    }

    setCompleting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/admin/appointments/${appointment.id}/admin-reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start,
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
            : `Could not move this booking (HTTP ${res.status})`;
        setErrorMessage(message);
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not move this booking'
      );
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-[#FAF9F6] px-4 py-3 sm:px-6 sm:py-4">
        <button
          type="button"
          onClick={() => {
            if (step === 'schedule' && needsServicePick) {
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
          {step === 'schedule' && needsServicePick ? 'Service' : 'Back'}
        </button>
        <div className="text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
            Reschedule
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
              Moving appointment…
            </p>
            <p className="mt-1 text-sm text-stone-500">
              Saving the new time to your dashboard.
            </p>
          </div>
        ) : bootstrapping ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Loader2 className="mb-4 h-8 w-8 animate-spin text-stone-400" />
            <p className="font-serif text-lg text-stone-900">Loading times</p>
            <p className="mt-1 text-sm text-stone-500">
              Preparing open slots for this appointment
            </p>
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
                  Choose the service for the new time
                  {clientName !== 'Unknown client' ? (
                    <>
                      {' '}
                      for{' '}
                      <span className="font-medium text-stone-900">
                        {clientName}
                      </span>
                    </>
                  ) : null}
                  .
                </p>
                <ManualBookingServicePicker
                  services={services}
                  groupHeaders={groupHeaders}
                  selectedService={selectedService}
                  onSelectService={(service) => {
                    setSelectedService(service);
                    setSelectedSlot(null);
                    setErrorMessage(null);
                  }}
                />
              </div>
            ) : selectedService ? (
              <ManualBookingSlotPicker
                key={selectedService.eventTypeId}
                eventTypeId={selectedService.eventTypeId}
                clientName={clientName}
                durationMins={selectedService.durationMins}
                selectedSlot={selectedSlot}
                onSelectSlot={(slot) => {
                  setSelectedSlot(slot);
                  setErrorMessage(null);
                }}
                seedDate={seedDateFromAppointment(appointment)}
              />
            ) : null}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-stone-200 bg-white/70 px-4 py-3 sm:px-5">
        {step === 'schedule' && !bootstrapping ? (
          <AdminSendSmsCheckbox
            className="mb-3"
            checked={sendSms}
            onChange={setSendSms}
            disabled={completing}
          />
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => {
              if (step === 'schedule' && needsServicePick) {
                setStep('service');
                setErrorMessage(null);
                return;
              }
              onBack();
            }}
            disabled={completing}
            className={BTN_SECONDARY}
          >
            {step === 'service' || bootstrapping ? 'Cancel' : 'Back'}
          </button>
          {step === 'service' ? (
            <button
              type="button"
              onClick={() => {
                if (!selectedService) return;
                setStep('schedule');
                setErrorMessage(null);
              }}
              disabled={!selectedService || completing}
              className={BTN_PRIMARY}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!canConfirm}
              className={BTN_PRIMARY}
            >
              {completing ? 'Saving…' : 'Confirm new time'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
