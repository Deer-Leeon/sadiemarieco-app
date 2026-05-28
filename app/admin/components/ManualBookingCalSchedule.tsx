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

/** Render size before scale — tuned for month view + time slots. */
const CAL_RENDER_WIDTH_PX = 440;
const CAL_RENDER_HEIGHT_PX = 540;
const CAL_SCALE = 0.9;

const VIEWPORT_WIDTH_PX = Math.round(CAL_RENDER_WIDTH_PX * CAL_SCALE);
const VIEWPORT_HEIGHT_PX = Math.round(CAL_RENDER_HEIGHT_PX * CAL_SCALE);

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
    <div className="space-y-2">
      <div
        className="mx-auto overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm"
        style={{
          width: VIEWPORT_WIDTH_PX,
          height: VIEWPORT_HEIGHT_PX,
          maxWidth: '100%',
        }}
      >
        <div
          style={{
            width: CAL_RENDER_WIDTH_PX,
            height: CAL_RENDER_HEIGHT_PX,
            transform: `scale(${CAL_SCALE})`,
            transformOrigin: 'top left',
          }}
        >
          <Cal
            key={embedKey}
            namespace={CAL_MANUAL_BOOKING_NAMESPACE}
            calLink={calLink}
            config={embedConfig}
            style={{
              width: CAL_RENDER_WIDTH_PX,
              height: CAL_RENDER_HEIGHT_PX,
              overflow: 'auto',
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-0.5 text-xs text-stone-500">
        <span>Scroll the picker for more times</span>
        <button
          type="button"
          onClick={() => setEmbedKey((k) => k + 1)}
          className="font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export function ManualBookingCompletingOverlay() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Loader2 className="h-7 w-7 animate-spin text-stone-400" />
      <p className="font-serif text-lg text-stone-900">Saving appointment…</p>
      <p className="text-sm text-stone-500">Updating Cal.com and your calendar</p>
    </div>
  );
}
