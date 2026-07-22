/**
 * Schedule a one-shot QStash delayed job to release an abandoned checkout
 * hold after CHECKOUT_HOLD_SECONDS. Fire-and-forget: failures are logged
 * but must not block `/api/booking/init`.
 *
 * If this publish fails (bad token / wrong QSTASH_URL region), the checkout
 * page still calls `/api/booking/release-hold` at 00:00 and
 * `/api/cron/cleanup-abandoned` sweeps leftovers.
 */

import { CHECKOUT_HOLD_SECONDS } from '@/lib/booking-hold';
import { createQStashClient } from '@/lib/qstash-client';

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

export async function scheduleAbandonedHoldRelease(
  calBookingUid: string
): Promise<{ scheduled: boolean; messageId?: string; reason?: string }> {
  const uid = typeof calBookingUid === 'string' ? calBookingUid.trim() : '';
  if (!uid) {
    return { scheduled: false, reason: 'missing_cal_booking_uid' };
  }

  const qstash = createQStashClient();
  if (!qstash) {
    console.error(
      '[schedule-abandoned-hold] QSTASH_TOKEN missing — hold will not auto-release via QStash'
    );
    return { scheduled: false, reason: 'qstash_not_configured' };
  }

  try {
    const res = await qstash.publishJSON({
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/qstash/release-hold`,
      body: { calBookingUid: uid },
      delay: CHECKOUT_HOLD_SECONDS,
    });
    return {
      scheduled: true,
      messageId:
        typeof res?.messageId === 'string' ? res.messageId : undefined,
    };
  } catch (err) {
    console.error('[schedule-abandoned-hold] publish failed', {
      calBookingUid: uid,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      scheduled: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
