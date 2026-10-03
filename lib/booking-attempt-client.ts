/**
 * Browser session for one public booking attempt.
 * The id lives in sessionStorage so /book, the desktop drawer, and
 * /checkout share it. No name, phone, or email is sent.
 */

const ID_KEY = 'sadie_booking_attempt_id';
const SURFACE_KEY = 'sadie_booking_attempt_surface';

export type BookingAttemptClientSurface = 'phone' | 'desktop';

let lastReported = '';

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function newAttemptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const rand = Math.floor(Math.random() * 16);
    const nibble = ch === 'x' ? rand : (rand & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function postAttempt(
  body: Record<string, unknown>,
  beacon: boolean
): void {
  // Selenium / Puppeteer / Playwright set this; real visitors never do.
  if (typeof navigator !== 'undefined' && navigator.webdriver) return;
  const json = JSON.stringify(body);
  const url = '/api/booking/attempt';
  if (
    beacon &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    const blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
    if (navigator.sendBeacon(url, blob)) return;
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive: true,
  }).catch(() => {});
}

export function bookingAttemptId(): string | null {
  return store()?.getItem(ID_KEY) ?? null;
}

export function bookingAttemptSurface(): BookingAttemptClientSurface | null {
  const value = store()?.getItem(SURFACE_KEY);
  return value === 'phone' || value === 'desktop' ? value : null;
}

/** New attempt. Closes the previous one in this tab. */
export function beginBookingAttempt(
  surface: BookingAttemptClientSurface
): string {
  const prev = bookingAttemptId();
  if (prev) {
    postAttempt(
      {
        attemptId: prev,
        surface: bookingAttemptSurface() || surface,
        leave: true,
      },
      true
    );
  }
  const id = newAttemptId();
  lastReported = '';
  store()?.setItem(ID_KEY, id);
  store()?.setItem(SURFACE_KEY, surface);
  return id;
}

/** Keep the current attempt when it is this surface, or start one. */
export function ensureBookingAttempt(
  surface: BookingAttemptClientSurface
): string {
  const existing = bookingAttemptId();
  const existingSurface = bookingAttemptSurface();
  if (existing && existingSurface === surface) return existing;
  if (existing && existingSurface && existingSurface !== surface) {
    return beginBookingAttempt(surface);
  }
  if (existing) {
    store()?.setItem(SURFACE_KEY, surface);
    return existing;
  }
  const id = newAttemptId();
  lastReported = '';
  store()?.setItem(ID_KEY, id);
  store()?.setItem(SURFACE_KEY, surface);
  return id;
}

export function checkoutMethodFromExpress(
  type: string | null | undefined
): 'apple_pay' | 'card' | 'google_pay' | 'link' {
  if (type === 'apple_pay' || type === 'google_pay' || type === 'link') return type;
  return 'card';
}

export function reportBookingStep(
  step: string,
  service?: string | null,
  checkoutMethod?: 'apple_pay' | 'card' | 'google_pay' | 'link' | null
): void {
  const method =
    checkoutMethod === 'apple_pay' ||
    checkoutMethod === 'card' ||
    checkoutMethod === 'google_pay' ||
    checkoutMethod === 'link'
      ? checkoutMethod
      : null;
  const signature = method ? `${step}:${method}` : step;
  if (!step || signature === lastReported) return;
  const attemptId = bookingAttemptId();
  const surface = bookingAttemptSurface();
  if (!attemptId || !surface) return;
  lastReported = signature;
  const label = service?.trim();
  postAttempt(
    {
      attemptId,
      surface,
      step,
      ...(label ? { service: label.slice(0, 120) } : {}),
      ...(method ? { checkoutMethod: method } : {}),
    },
    false
  );
}

export function leaveBookingAttempt(): void {
  const attemptId = bookingAttemptId();
  const surface = bookingAttemptSurface();
  if (!attemptId || !surface) return;
  lastReported = '';
  postAttempt({ attemptId, surface, leave: true }, true);
}
