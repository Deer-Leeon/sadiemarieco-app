/**
 * Schedule a one-shot QStash delayed job to release an abandoned checkout
 * hold after CHECKOUT_HOLD_SECONDS. Fire-and-forget: failures are logged
 * but must not block booking/init or the Cal webhook.
 *
 * CommonJS so `lib/legacy-handlers/webhook.js` can require() it. The
 * TypeScript wrapper re-exports the same implementation.
 *
 * Keep `CHECKOUT_HOLD_SECONDS` in sync with `lib/booking-hold.ts`.
 */

const { Client: QStashClient } = require('@upstash/qstash');

/** Keep in sync with `lib/booking-hold.ts`. */
const CHECKOUT_HOLD_SECONDS = 10 * 60;

const DEFAULT_QSTASH_URL = 'https://qstash-us-east-1.upstash.io';

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

function createQStashClient() {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = (process.env.QSTASH_URL?.trim() || DEFAULT_QSTASH_URL).replace(
    /\/$/,
    ''
  );
  return new QStashClient({ token, baseUrl });
}

/**
 * @param {string} calBookingUid
 * @returns {Promise<{ scheduled: boolean, messageId?: string, reason?: string }>}
 */
async function scheduleAbandonedHoldRelease(calBookingUid) {
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

module.exports = {
  scheduleAbandonedHoldRelease,
  CHECKOUT_HOLD_SECONDS,
};
