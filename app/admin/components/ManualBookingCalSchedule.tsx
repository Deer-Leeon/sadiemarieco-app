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

/** Cal booker intrinsic size before CSS scale (matches public drawer layout). */
const CAL_EMBED_WIDTH_PX = 400;
const CAL_EMBED_HEIGHT_PX = 540;
/** Scale down so month + time slots fit inside the admin modal without scrolling. */
const CAL_EMBED_SCALE = 0.7;

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

  const scaledHeight = Math.round(CAL_EMBED_HEIGHT_PX * CAL_EMBED_SCALE);

  const embedConfig = useMemo(
    () => ({
      layout: 'month_view' as const,
      theme: 'light' as const,
      name: clientName,
      email: clientEmail,
      location: calEmbedPhoneLocation(clientPhone),
      'metadata[manual_admin_booking]': 'true',
      'ui.autoscroll': 'false',
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
        className="mx-auto overflow-hidden rounded-lg border border-stone-600 bg-white"
        style={{ width: CAL_EMBED_WIDTH_PX * CAL_EMBED_SCALE, height: scaledHeight }}
      >
        <div
          className="origin-top"
          style={{
            width: CAL_EMBED_WIDTH_PX,
            height: CAL_EMBED_HEIGHT_PX,
            transform: `scale(${CAL_EMBED_SCALE})`,
          }}
        >
          <Cal
            key={embedKey}
            namespace={CAL_MANUAL_BOOKING_NAMESPACE}
            calLink={calLink}
            config={embedConfig}
            style={{
              width: CAL_EMBED_WIDTH_PX,
              height: CAL_EMBED_HEIGHT_PX,
              overflow: 'hidden',
            }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={() => setEmbedKey((k) => k + 1)}
        className="mx-auto mt-1.5 block text-[10px] text-stone-500 underline-offset-2 hover:text-stone-300 hover:underline"
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
