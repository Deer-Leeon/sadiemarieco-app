/**
 * Schedule a one-shot QStash delayed job to release an abandoned checkout
 * hold after CHECKOUT_HOLD_SECONDS. Fire-and-forget: failures are logged
 * but must not block `/api/booking/init` or the Cal webhook.
 *
 * Scheduled from:
 *   • `/api/booking/init` (success + contact-channel failure paths)
 *   • Cal webhook when a public pending appointment is stored
 *   • `/api/book/create` immediately after Cal creates the hold
 *
 * Duplicate schedules are safe — `/api/qstash/release-hold` is idempotent.
 * If publish fails, checkout still calls `/api/booking/release-hold` at
 * 00:00 and `/api/cron/cleanup-abandoned` sweeps leftovers.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./schedule-abandoned-hold-release.js') as {
  scheduleAbandonedHoldRelease: (
    calBookingUid: string
  ) => Promise<{ scheduled: boolean; messageId?: string; reason?: string }>;
};

export const scheduleAbandonedHoldRelease = impl.scheduleAbandonedHoldRelease;
