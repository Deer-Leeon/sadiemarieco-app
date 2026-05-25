/**
 * Abandoned-checkout hold window — keep in sync with:
 *   • `app/api/cron/cleanup-abandoned/route.ts` (CAL_CANCEL_REASON)
 *   • `api/webhook.js` (SYSTEM_ABANDON_CANCEL_REASON + legacy list)
 */
export const CHECKOUT_HOLD_MINUTES = 8;

export const CHECKOUT_HOLD_MS = CHECKOUT_HOLD_MINUTES * 60 * 1000;

export const CAL_ABANDON_CANCEL_REASON = `Checkout abandoned after ${CHECKOUT_HOLD_MINUTES} minutes.`;

export const HOLD_EXPIRED_MESSAGE = `Your ${CHECKOUT_HOLD_MINUTES}-minute hold has expired. To re-book this exact time, please check the calendar again in 2 minutes.`;

export function holdDeadlineMs(createdAt: Date | string): number {
  const start =
    createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return Date.now();
  return start + CHECKOUT_HOLD_MS;
}

export function isHoldExpired(
  createdAt: Date | string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!createdAt) return false;
  return nowMs >= holdDeadlineMs(createdAt);
}

export function formatCountdownMmSs(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
