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

/**
 * Same-origin flag so the homepage drawer can skip abandon-on-pagehide
 * when checkout promotes from the iframe to a top-level /checkout URL.
 * Must stay in sync with `public/js/main.js`.
 */
export const KEEP_HOLD_STORAGE_KEY = 'sadieMarieKeepCheckoutHold';

let keepHoldThroughUnload = false;
let rememberedHoldUid = '';

export function setKeepHoldThroughUnload(keep: boolean): void {
  keepHoldThroughUnload = keep;
}

export function isKeepHoldThroughUnload(): boolean {
  return keepHoldThroughUnload;
}

/**
 * Call immediately before a same-origin navigation that should keep the
 * pending Cal hold (drawer iframe → /checkout, 3DS return, etc.).
 *
 * The homepage's `pagehide` listener lives in a different JS bundle, so
 * the in-memory flag above cannot stop it. sessionStorage + a parent
 * window property are written synchronously before `location.replace`.
 */
export function markKeepHoldThroughNavigation(uid: string): void {
  keepHoldThroughUnload = true;
  const trimmed = uid.trim();
  if (!trimmed || typeof window === 'undefined') return;

  try {
    sessionStorage.setItem(KEEP_HOLD_STORAGE_KEY, trimmed);
  } catch {
    /* private mode / blocked storage */
  }

  try {
    (
      window as Window & { __sadieKeepCheckoutHold?: string }
    ).__sadieKeepCheckoutHold = trimmed;
    if (window.parent && window.parent !== window) {
      (
        window.parent as Window & { __sadieKeepCheckoutHold?: string }
      ).__sadieKeepCheckoutHold = trimmed;
      window.parent.sessionStorage.setItem(KEEP_HOLD_STORAGE_KEY, trimmed);
    }
  } catch {
    /* cross-origin parent — homepage drawer is same-origin */
  }

  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'sadie-checkout:keep-hold', uid: trimmed },
        window.location.origin
      );
    }
  } catch {
    /* ignore */
  }
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
