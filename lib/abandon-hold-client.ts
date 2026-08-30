/**
 * Release a pending checkout hold when the tab/webview is actually
 * torn down (Google Maps in-app browser ✓ / Done, closed tab).
 *
 * Uses sendBeacon so the request can outlive the page. Do not hook
 * `visibilitychange` — Apple Pay sheets hide the page without leaving.
 * Skip when `event.persisted` (back-forward cache) or when Stripe is
 * about to redirect for 3DS / we are handing off to /checkout.
 */

const ABANDON_PATH = '/api/booking/abandon-hold';

let keepHoldThroughUnload = false;

export function setKeepHoldThroughUnload(keep: boolean): void {
  keepHoldThroughUnload = keep;
}

export function isKeepHoldThroughUnload(): boolean {
  return keepHoldThroughUnload;
}

export function sendAbandonHoldBeacon(calBookingUid: string): void {
  const uid = calBookingUid.trim();
  if (!uid || typeof window === 'undefined') return;

  const body = JSON.stringify({ calBookingUid: uid });
  try {
    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(ABANDON_PATH, blob)) return;
    }
  } catch {
    /* fall through to keepalive fetch */
  }

  try {
    void fetch(ABANDON_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    /* QStash still releases at window end */
  }
}
