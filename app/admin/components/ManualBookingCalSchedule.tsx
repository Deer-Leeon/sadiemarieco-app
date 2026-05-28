'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Cal, { getCalApi, type EmbedEvent } from '@calcom/embed-react';
import { Loader2 } from 'lucide-react';

import {
  ADMIN_CAL_UI_CONFIG,
  CAL_USERNAME,
  calEmbedPhoneLocation,
  extractBookingDataFromEvent,
} from '@/lib/cal-embed-shared';

const CAL_MANUAL_BOOKING_NAMESPACE = 'manual-booking';

interface Props {
  serviceSlug: string;
  serviceTitle: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  onScheduled: (data: {
    calBookingUid: string;
    startTime: string;
    endTime: string | null;
  }) => void;
  onError: (message: string) => void;
}

export default function ManualBookingCalSchedule({
  serviceSlug,
  serviceTitle,
  clientName,
  clientEmail,
  clientPhone,
  onScheduled,
  onError,
}: Props) {
  const completedRef = useRef(false);
  const [embedKey, setEmbedKey] = useState(0);

  const calLink = `${CAL_USERNAME}/${serviceSlug}`;

  const embedConfig = useMemo(
    () => ({
      layout: 'month_view' as const,
      theme: 'light' as const,
      name: clientName,
      email: clientEmail,
      location: calEmbedPhoneLocation(clientPhone),
      'metadata[manual_admin_booking]': 'true',
    }),
    [clientName, clientEmail, clientPhone]
  );

  useEffect(() => {
    let cancelled = false;
    type CalApi = Awaited<ReturnType<typeof getCalApi>>;
    let api: CalApi | null = null;

    const handleSuccess = (event: unknown) => {
      if (completedRef.current) return;
      const { uid, startTime, endTime } = extractBookingDataFromEvent(event);
      if (!uid || !startTime) {
        onError(
          'Cal.com did not return a booking reference. Try picking the time again.'
        );
        return;
      }
      completedRef.current = true;
      onScheduled({ calBookingUid: uid, startTime, endTime });
    };

    const handleLinkFailed = (e: EmbedEvent<'linkFailed'>) => {
      if (cancelled || completedRef.current) return;
      const code = e.detail?.data?.code ?? 'unknown';
      onError(
        `Cal.com could not load availability (error ${code}). Check the service slug in Services, or open cal.com/${CAL_USERNAME}/${serviceSlug} directly.`
      );
    };

    (async () => {
      try {
        const resolved = await getCalApi({
          namespace: CAL_MANUAL_BOOKING_NAMESPACE,
        });
        if (cancelled) return;
        api = resolved;
        try {
          api('ui', ADMIN_CAL_UI_CONFIG);
        } catch (uiErr) {
          console.warn('[ManualBookingCalSchedule] cal ui config failed', uiErr);
        }
        api('on', {
          action: 'bookingSuccessful',
          callback: handleSuccess,
        });
        api('on', {
          action: 'bookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('on', { action: 'linkFailed', callback: handleLinkFailed });
      } catch (err) {
        console.error('[ManualBookingCalSchedule] failed to attach Cal listener', err);
        onError('Could not connect to Cal.com. Refresh and try again.');
      }
    })();

    return () => {
      cancelled = true;
      if (!api) return;
      try {
        api('off', { action: 'bookingSuccessful', callback: handleSuccess });
        api('off', {
          action: 'bookingSuccessfulV2',
          callback: handleSuccess,
        });
        api('off', { action: 'linkFailed', callback: handleLinkFailed });
      } catch (err) {
        console.error('[ManualBookingCalSchedule] failed to detach Cal listener', err);
      }
    };
  }, [embedKey, onError, onScheduled, serviceSlug]);

  useEffect(() => {
    completedRef.current = false;
  }, [embedKey, serviceSlug, clientName, clientEmail, clientPhone]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-300">
        Pick a time for{' '}
        <span className="text-stone-100">{serviceTitle}</span>. Only dates and
        times Cal.com shows as open are bookable — same calendar your clients
        see.
      </p>
      <div className="overflow-hidden rounded-xl border border-stone-600 bg-white shadow-sm">
        <Cal
          key={embedKey}
          namespace={CAL_MANUAL_BOOKING_NAMESPACE}
          calLink={calLink}
          config={embedConfig}
          style={{
            width: '100%',
            height: 'min(420px, 55vh)',
            overflow: 'auto',
          }}
        />
      </div>
      <p className="text-xs text-stone-500">
        Client details are prefilled from the previous step. Confirm the slot in
        Cal to finish — no card checkout.
      </p>
      <button
        type="button"
        onClick={() => setEmbedKey((k) => k + 1)}
        className="text-xs text-stone-400 underline-offset-2 hover:text-stone-200 hover:underline"
      >
        Reload calendar
      </button>
    </div>
  );
}

export function ManualBookingCompletingOverlay() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-stone-300" />
      <p className="font-serif text-lg text-stone-100">Saving appointment…</p>
      <p className="text-sm text-stone-400">
        Confirming on Cal.com and updating your dashboard.
      </p>
    </div>
  );
}
