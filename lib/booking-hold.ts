/**
 * Abandoned-checkout hold window — keep in sync with:
 *   • `lib/release-abandoned-hold.ts` (Cal cancel reason)
 *   • `app/api/qstash/release-hold/route.ts` (QStash delay)
 *   • `api/webhook.js` (SYSTEM_ABANDON_CANCEL_REASON + legacy list)
 *
 * Holds are released by a per-booking QStash delayed message scheduled
 * from `/api/booking/init`, the Cal webhook (public pending upserts),
 * `/api/book/create`, the checkout page at 00:00, and a daily Vercel
 * cron sweep (`/api/cron/cleanup-abandoned`).
 */

/** Source of truth for countdown + QStash delay. */
export const CHECKOUT_HOLD_SECONDS = 10 * 60;

export const CHECKOUT_HOLD_MS = CHECKOUT_HOLD_SECONDS * 1000;

/** Fractional minutes — used by SQL interval helpers / older call sites. */
export const CHECKOUT_HOLD_MINUTES = CHECKOUT_HOLD_SECONDS / 60;

export function checkoutHoldDurationLabel(): string {
  if (CHECKOUT_HOLD_SECONDS < 60) {
    return `${CHECKOUT_HOLD_SECONDS} seconds`;
  }
  const mins = CHECKOUT_HOLD_SECONDS / 60;
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}

export const CAL_ABANDON_CANCEL_REASON = `Checkout abandoned after ${checkoutHoldDurationLabel()}.`;

/** Older cancel reasons still echoed by Cal for holds released before the window changed. */
export const LEGACY_ABANDON_CANCEL_REASONS = [
  'Checkout abandoned after 8 minutes.',
  'Checkout abandoned after 10 minutes.',
] as const;

export const HOLD_EXPIRED_MESSAGE = `Your ${checkoutHoldDurationLabel()} hold has expired. Please pick a time on the calendar again to continue.`;

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

function normalizeAppointmentStatus(
  status: string | null | undefined
): string {
  return (status || '').toLowerCase();
}

export function isPendingCheckoutHoldStatus(
  status: string | null | undefined
): boolean {
  return normalizeAppointmentStatus(status) === 'pending';
}

export function isConfirmedBookingStatus(
  status: string | null | undefined
): boolean {
  return normalizeAppointmentStatus(status) === 'confirmed';
}

/**
 * Checkout UI + hold-release: only a still-pending (or already system-
 * canceled) hold can expire. Confirmed bookings keep their slot even
 * after the original 10-minute window.
 */
export function isAbandonedCheckoutHold(
  status: string | null | undefined,
  createdAt: Date | string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const normalized = normalizeAppointmentStatus(status);
  if (normalized === 'canceled_by_system') return true;
  if (normalized !== 'pending') return false;
  return isHoldExpired(createdAt, nowMs);
}

export function formatCountdownMmSs(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function isAbandonCancelReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (trimmed === CAL_ABANDON_CANCEL_REASON) return true;
  if (trimmed.startsWith('Checkout abandoned after ')) return true;
  return (LEGACY_ABANDON_CANCEL_REASONS as readonly string[]).includes(trimmed);
}
