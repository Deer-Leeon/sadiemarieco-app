'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Cal, { getCalApi, type EmbedEvent } from '@calcom/embed-react';
import { Loader2 } from 'lucide-react';

import {
  CAL_USERNAME,
  MANUAL_BOOKING_CAL_UI_CONFIG,
  calEmbedPhoneLocation,
  extractBookingDataFromEvent,
} from '@/lib/cal-embed-shared';

const CAL_MANUAL_BOOKING_NAMESPACE = 'manual-booking';

/**
 * Fixed iframe viewport. Cal runs in column_view so dates stay on the left and
 * the time list scrolls on the right inside the iframe when there are many slots.
 */
const CAL_EMBED_HEIGHT_PX = 500;

interface Props {
  serviceSlug: string;
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
      layout: 'column_view' as const,
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
          api('ui', MANUAL_BOOKING_CAL_UI_CONFIG);
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
    <div className="shrink-0">
      <div
        className="w-full overflow-hidden rounded-lg border border-stone-600 bg-white"
        style={{ height: CAL_EMBED_HEIGHT_PX }}
      >
        <Cal
          key={embedKey}
          namespace={CAL_MANUAL_BOOKING_NAMESPACE}
          calLink={calLink}
          config={embedConfig}
          style={{
            width: '100%',
            height: CAL_EMBED_HEIGHT_PX,
            overflow: 'auto',
          }}
        />
      </div>
      <p className="mt-1 text-center text-[10px] text-stone-500">
        Scroll the time list on the right if you don&apos;t see all slots.
      </p>
      <button
        type="button"
        onClick={() => setEmbedKey((k) => k + 1)}
        className="mx-auto mt-0.5 block text-[10px] text-stone-500 underline-offset-2 hover:text-stone-300 hover:underline"
      >
        Reload calendar
      </button>
    </div>
  );
}

export function ManualBookingCompletingOverlay() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-stone-300" />
      <p className="font-serif text-base text-stone-100">Saving appointment…</p>
    </div>
  );
}
