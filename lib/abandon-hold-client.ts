/**
 * Release a pending checkout hold when the tab/webview is actually
 * torn down (Google Maps in-app browser ✓ / Done, closed tab).
 *
 * Uses sendBeacon so the request can outlive the page. Do not hook
 * `visibilitychange` — Apple Pay sheets hide the page without leaving.
 * Skip when `event.persisted` (back-forward cache) or when Stripe is
 * about to redirect for 3DS / we are handing off to /checkout.
 *
 * iOS WKWebView (Maps in-app browser) often rejects sendBeacon blobs
 * with `application/json`. `text/plain` JSON is CORS-safelisted and the
 * abandon-hold route JSON.parses the raw body either way.
 */

const ABANDON_PATH = '/api/booking/abandon-hold';

let keepHoldThroughUnload = false;
let rememberedHoldUid = '';

export function setKeepHoldThroughUnload(keep: boolean): void {
  keepHoldThroughUnload = keep;
}

export function isKeepHoldThroughUnload(): boolean {
  return keepHoldThroughUnload;
}

/** Latest pending Cal UID, including holds created inside Apple Pay before React state updates. */
export function rememberActiveHoldUid(uid: string | null | undefined): void {
  rememberedHoldUid = typeof uid === 'string' ? uid.trim() : '';
}

export function rememberedActiveHoldUid(): string {
  return rememberedHoldUid;
}

function abandonUrl(): string {
  if (typeof window === 'undefined') return ABANDON_PATH;
  return new URL(ABANDON_PATH, window.location.origin).href;
}

export function sendAbandonHoldBeacon(calBookingUid?: string | null): void {
  const uid = (calBookingUid || rememberedHoldUid).trim();
  if (!uid || typeof window === 'undefined') return;

  const body = JSON.stringify({ calBookingUid: uid });
  const url = abandonUrl();
  try {
    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {
    /* fall through to keepalive fetch */
  }

  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    /* QStash still releases at window end */
  }
}
