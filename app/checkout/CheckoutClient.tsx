'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { track } from '@vercel/analytics';
import {
  checkoutHoldDurationLabel,
  formatCountdownMmSs,
  holdDeadlineMs,
  HOLD_EXPIRED_MESSAGE,
} from '@/lib/booking-hold';
import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
} from '@/lib/booking-analytics';
import { isValidEmail, formatUsPhoneAsYouType, clientPhoneValidationMessage, parseClientPhone } from '@/lib/client-identity';
import { BOOK_PHONE_MAX_WIDTH_PX } from '@/lib/book-public';
import {
  formatAppointmentWhen,
  formatServiceTitleForDisplay,
} from '@/lib/format-booking-time';
import type { BookingPaymentTiming } from '@/lib/appointment-stripe';
import { prefersApplePayDevice } from '@/lib/prefers-apple-pay';
import { type StripeElementsOptions } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { stripePromise } from '@/lib/stripe-browser';
import {
  isKeepHoldThroughUnload,
  sendAbandonHoldBeacon,
  setKeepHoldThroughUnload,
} from '@/lib/abandon-hold-client';
import CheckoutApplePayHost, {
  type CheckoutApplePayConfirmed,
} from './CheckoutApplePayHost';

function trackCheckoutEvent(
  name: string,
  data?: Record<string, string | number | boolean | null>
) {
  try {
    track(name, data);
  } catch {
    /* analytics must never break checkout */
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stripe Elements appearance — editorial-luxe palette
// ──────────────────────────────────────────────────────────────────────────
/**
 * Mirrors the design tokens used elsewhere in the app (sign-in widget,
 * admin dashboard surfaces). Theme `flat` gives the most minimal base —
 * no Stripe gradient/shadow chrome to fight with — and we layer our own
 * borders / focus rings via the `rules` map.
 *
 * Colour anchors (matching `tailwindcss/colors.stone`):
 *   stone-900: #1c1917  — body text, focused borders, primary CTA
 *   stone-600: #57534e  — labels (eyebrow uppercase tracking)
 *   stone-500: #78716c  — secondary text inside the Element
 *   stone-400: #a8a29e  — placeholder text
 *   stone-200: #e7e5e4  — resting borders, dividers
 *   stone-50:  #fafaf9  — selected-tab background
 *   rose-700:  #b91c1c  — validation errors (matches our admin error family)
 */
/** Strip Stripe 3DS redirect params while keeping the Cal booking context. */
function clearStripeRedirectParams(uid: string, name: string, email: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('setup_intent');
  url.searchParams.delete('setup_intent_client_secret');
  url.searchParams.delete('payment_intent');
  url.searchParams.delete('payment_intent_client_secret');
  url.searchParams.delete('redirect_status');
  url.searchParams.set('uid', uid);
  if (name) url.searchParams.set('name', name);
  else url.searchParams.delete('name');
  if (email) url.searchParams.set('email', email);
  else url.searchParams.delete('email');
  const search = url.searchParams.toString();
  window.history.replaceState(
    {},
    '',
    search ? `${url.pathname}?${search}` : url.pathname
  );
}

async function callBookingConfirm(params: {
  setupIntentId?: string;
  paymentIntentId?: string;
  calBookingUid: string;
  name: string;
  email: string;
}): Promise<{
  calWarning: string | null;
  contact: { sms: boolean; email: boolean };
}> {
  const res = await fetchWithTimeout(
    '/api/booking/confirm',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params.paymentIntentId
          ? { paymentIntentId: params.paymentIntentId }
          : { setupIntentId: params.setupIntentId }),
        calBookingUid: params.calBookingUid,
        ...(params.name ? { name: params.name } : {}),
        ...(params.email ? { email: params.email } : {}),
      }),
    },
    45_000
  );

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    if (payload?.error === 'cart_hold_expired') {
      throw new Error(payload.message ?? HOLD_EXPIRED_MESSAGE);
    }
    throw new Error(
      payload?.message ??
        payload?.error ??
        `Could not finalise your appointment (HTTP ${res.status})`
    );
  }

  const data = (await res.json()) as {
    ok?: boolean;
    cal_accept_error?: string | null;
    contact?: { sms?: boolean; email?: boolean };
  };
  // Prefer server flags (sms_opt_in + stored email). Fall back to the
  // checkout URL email only when the payload omitted `contact`.
  if (data.contact) {
    return {
      calWarning: data.cal_accept_error ?? null,
      contact: {
        sms: data.contact.sms === true,
        email: data.contact.email === true,
      },
    };
  }
  return {
    calWarning: data.cal_accept_error ?? null,
    contact: {
      sms: false,
      email: Boolean(params.email),
    },
  };
}

/** Fetch that fails instead of hanging forever on a stalled network/API. */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        'This is taking too long. Please check your connection and try again.'
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function readThreeDsSetupIntentId(
  params: ReturnType<typeof useSearchParams>
): string | null {
  if (params.get('redirect_status') !== 'succeeded') return null;
  const id = params.get('setup_intent')?.trim() ?? '';
  return id.startsWith('seti_') ? id : null;
}

function readThreeDsPaymentIntentId(
  params: ReturnType<typeof useSearchParams>
): string | null {
  if (params.get('redirect_status') !== 'succeeded') return null;
  const id = params.get('payment_intent')?.trim() ?? '';
  return id.startsWith('pi_') ? id : null;
}

/**
 * Map Stripe's raw decline / setup errors to client-facing copy.
 * Stripe still may show its own line under the card field; our banner
 * should never expose "live mode" / "test card" developer jargon.
 */
function friendlyStripeSetupError(error: {
  message?: string | null;
  code?: string | null;
  decline_code?: string | null;
} | null | undefined): string {
  const message = (error?.message ?? '').toLowerCase();
  const code = (error?.code ?? '').toLowerCase();
  const decline = (error?.decline_code ?? '').toLowerCase();

  if (
    message.includes('test card') ||
    message.includes('live mode') ||
    message.includes('in test mode')
  ) {
    return 'This card could not be verified. Please enter a valid debit or credit card.';
  }

  if (
    decline === 'insufficient_funds' ||
    message.includes('insufficient funds')
  ) {
    return 'This card was declined due to insufficient funds. Please try a different card.';
  }

  if (
    decline === 'expired_card' ||
    code === 'expired_card' ||
    code === 'invalid_expiry_year' ||
    code === 'invalid_expiry_month' ||
    code === 'incomplete_expiry' ||
    message.includes('expir')
  ) {
    return 'The expiration date looks incorrect. Please check it and try again.';
  }

  if (
    decline === 'incorrect_cvc' ||
    code === 'incorrect_cvc' ||
    code === 'incomplete_cvc' ||
    message.includes('security code') ||
    message.includes('cvc')
  ) {
    return 'The security code looks incorrect. Please check it and try again.';
  }

  if (
    decline === 'incorrect_zip' ||
    code === 'incorrect_zip' ||
    message.includes('zip') ||
    message.includes('postal')
  ) {
    return 'The billing ZIP code looks incorrect. Please check it and try again.';
  }

  if (
    decline === 'incorrect_number' ||
    code === 'incorrect_number' ||
    code === 'incomplete_number' ||
    message.includes('card number')
  ) {
    return 'That card number does not look right. Please check it and try again.';
  }

  if (code === 'card_declined' || message.includes('declined')) {
    return 'Your card was declined. Please try a different card or contact your bank.';
  }

  if (
    code === 'setup_intent_unexpected_state' ||
    code === 'payment_intent_unexpected_state' ||
    message.includes('processing error') ||
    message.includes('already succeeded')
  ) {
    return 'Please check your card details and try again.';
  }

  if (error?.message && !message.includes('mode') && error.message.length < 160) {
    // Stripe’s shorter, already-polished messages (e.g. incomplete fields).
    return error.message;
  }

  return 'We could not save your card. Please check the details and try again.';
}

function formatUsdFromCents(cents: number | null): string {
  if (!cents || cents <= 0) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function prefersPhoneBooker(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${BOOK_PHONE_MAX_WIDTH_PX}px)`).matches;
}

/** Full-page checkout (card form or pay choice) → homepage drawer or /book. */
function checkoutResumeUrl(params: {
  uid: string;
  name: string;
  email: string;
  phone: string;
  service: string;
  time: string | null;
}): string {
  const phoneBooker = prefersPhoneBooker();
  const url = new URL(phoneBooker ? '/book' : '/', window.location.origin);
  url.searchParams.set('resume_checkout', params.uid);
  if (params.name) url.searchParams.set('name', params.name);
  if (params.email) url.searchParams.set('email', params.email);
  if (params.phone) url.searchParams.set('phone', params.phone);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.time) url.searchParams.set('time', params.time);
  if (!phoneBooker) url.hash = 'services';
  return url.toString();
}

type CheckoutConfirmed = {
  name: string;
  calWarning: string | null;
  contact: { sms: boolean; email: boolean };
};

const STRIPE_APPEARANCE: StripeElementsOptions['appearance'] = {
  theme: 'flat',
  variables: {
    colorPrimary: '#1c1917',
    colorBackground: '#ffffff',
    colorText: '#1c1917',
    colorTextSecondary: '#78716c',
    colorTextPlaceholder: '#a8a29e',
    colorDanger: '#b91c1c',
    colorIconTab: '#57534e',
    colorIconTabHover: '#1c1917',
    fontFamily:
      '"DM Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSizeBase: '14px',
    spacingUnit: '4px',
    borderRadius: '8px',
  },
  rules: {
    '.Label': {
      fontSize: '10px',
      fontWeight: '600',
      letterSpacing: '0.22em',
      textTransform: 'uppercase',
      color: '#57534e',
      marginBottom: '8px',
    },
    '.Input': {
      border: '1px solid #e7e5e4',
      backgroundColor: '#ffffff',
      padding: '12px 14px',
      fontSize: '14px',
      color: '#1c1917',
      boxShadow: 'none',
      transition: 'border-color 150ms ease, box-shadow 150ms ease',
    },
    '.Input:focus': {
      borderColor: '#1c1917',
      boxShadow: '0 0 0 2px rgba(28, 25, 23, 0.08)',
      outline: 'none',
    },
    '.Input--invalid': {
      borderColor: '#b91c1c',
      boxShadow: '0 0 0 2px rgba(185, 28, 28, 0.08)',
    },
    '.Tab': {
      border: '1px solid #e7e5e4',
      backgroundColor: '#ffffff',
      borderRadius: '8px',
      padding: '12px 14px',
      transition: 'border-color 150ms ease, background-color 150ms ease',
    },
    '.Tab:hover': {
      borderColor: '#d6d3d1',
    },
    '.Tab--selected': {
      borderColor: '#1c1917',
      backgroundColor: '#fafaf9',
      boxShadow: 'none',
    },
    '.Error': {
      fontSize: '12px',
      color: '#b91c1c',
      marginTop: '6px',
    },
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Top-level client component
// ──────────────────────────────────────────────────────────────────────────
interface CheckoutClientProps {
  initialHoldCreatedAt?: string | null;
  initialHoldExpired?: boolean;
  initialBookingTime?: string | null;
  initialEndTime?: string | null;
  initialServiceName?: string | null;
  initialQuotedServicePriceCents?: number | null;
}

export default function CheckoutClient({
  initialHoldCreatedAt = null,
  initialHoldExpired = false,
  initialBookingTime = null,
  initialEndTime = null,
  initialServiceName = null,
  initialQuotedServicePriceCents = null,
}: CheckoutClientProps) {
  const params = useSearchParams();
  // The Cal.com embed handler in `public/js/main.js` redirects here on
  // `bookingSuccessful` with whatever it could extract from the event
  // payload. `uid` is the only hard requirement (we need it to accept
  // the booking on Cal in `/api/booking/confirm`); name + email are
  // best-effort prefill and fall back to whatever the Stripe Element
  // collects from the visitor on this page.
  const uid = params.get('uid')?.trim() ?? '';
  const name = params.get('name')?.trim() ?? '';
  // Cal phone-only bookings pass <digits>@sms.cal.com — never prefill Stripe Link with that.
  const emailRaw = params.get('email')?.trim() ?? '';
  const email = isValidEmail(emailRaw) ? emailRaw.trim().toLowerCase() : '';
  const urlPayMode = params.get('payMode')?.trim() ?? '';
  const urlPayNow = urlPayMode === 'now';
  const skipChoose = urlPayMode === 'now' || urlPayMode === 'later';
  const embedInDrawer = params.get('embed')?.trim() === 'drawer';
  const urlPhone = params.get('phone')?.trim() ?? '';
  const [contactName, setContactName] = useState(name);
  const [contactEmail, setContactEmail] = useState(email);
  const [contactPhone, setContactPhone] = useState(
    urlPhone ? formatUsPhoneAsYouType(urlPhone) : ''
  );
  const [paymentTiming, setPaymentTiming] = useState<BookingPaymentTiming>(
    urlPayNow ? 'pay_now' : 'pay_later'
  );
  // Drawer already showed pay-later / pay-now. payMode skips that step
  // and opens the card form. Bare /checkout?uid= still shows choose.
  const [payPhase, setPayPhase] = useState<'choose' | 'card' | 'details'>(
    skipChoose ? 'card' : 'choose'
  );
  const [confirmed, setConfirmed] = useState<CheckoutConfirmed | null>(null);
  const [mountApplePay, setMountApplePay] = useState(false);
  const [applePayAvailable, setApplePayAvailable] = useState<boolean | null>(
    null
  );
  const [applePaySubmitting, setApplePaySubmitting] = useState(false);
  const [applePayError, setApplePayError] = useState<string | null>(null);
  const threeDsSetupIntentId = useMemo(
    () => readThreeDsSetupIntentId(params),
    [params]
  );
  const threeDsPaymentIntentId = useMemo(
    () => readThreeDsPaymentIntentId(params),
    [params]
  );

  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [holdCreatedAt, setHoldCreatedAt] = useState<string | null>(
    initialHoldCreatedAt
  );
  const [holdExpired, setHoldExpired] = useState(initialHoldExpired);
  const [countdownLabel, setCountdownLabel] = useState('');
  const [bookingTime, setBookingTime] = useState<string | null>(
    initialBookingTime
  );
  const [endTime, setEndTime] = useState<string | null>(initialEndTime);
  const [serviceName, setServiceName] = useState<string | null>(
    initialServiceName
  );
  const [quotedServicePriceCents, setQuotedServicePriceCents] = useState<
    number | null
  >(initialQuotedServicePriceCents);
  /** Gate the return CTA until Cal cancel finishes — otherwise the booker can reopen while the only Saturday slot is still held. */
  const [holdReleaseState, setHoldReleaseState] = useState<
    'idle' | 'releasing' | 'released' | 'failed'
  >('idle');
  const checkoutConfirmedRef = useRef(confirmed);
  checkoutConfirmedRef.current = confirmed;

  useEffect(() => {
    setMountApplePay(prefersApplePayDevice());
  }, []);

  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      if (isKeepHoldThroughUnload()) return;
      if (checkoutConfirmedRef.current) return;
      if (holdExpired) return;
      const currentUid = uid.trim();
      if (!currentUid) return;
      sendAbandonHoldBeacon(currentUid);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [uid, holdExpired]);

  const onApplePayResolved = useCallback((available: boolean) => {
    setApplePayAvailable((prev) => (prev === true ? true : available));
  }, []);

  const navigateToCardCheckout = useCallback(
    (timing: BookingPaymentTiming) => {
      const url = new URL('/checkout', window.location.origin);
      url.searchParams.set('uid', uid);
      url.searchParams.set(
        'payMode',
        timing === 'pay_now' ? 'now' : 'later'
      );
      if (contactName) url.searchParams.set('name', contactName);
      else url.searchParams.delete('name');
      if (contactEmail) url.searchParams.set('email', contactEmail);
      else url.searchParams.delete('email');
      const target =
        window.top && window.top !== window ? window.top : window;
      setKeepHoldThroughUnload(true);
      target.location.replace(url.toString());
    },
    [uid, contactName, contactEmail]
  );

  const goBackToPayChoice = useCallback(() => {
    setApplePayError(null);
    if (embedInDrawer) {
      setPayPhase('choose');
      if (typeof window === 'undefined') return;
      const url = new URL(window.location.href);
      if (!url.searchParams.has('payMode')) return;
      url.searchParams.delete('payMode');
      const search = url.searchParams.toString();
      window.history.replaceState(
        {},
        '',
        search ? `${url.pathname}?${search}` : url.pathname
      );
      return;
    }
    const resume = checkoutResumeUrl({
      uid,
      name: contactName,
      email: contactEmail,
      phone: contactPhone,
      service: formatServiceTitleForDisplay(serviceName),
      time: bookingTime,
    });
    const target =
      window.top && window.top !== window ? window.top : window;
    setKeepHoldThroughUnload(true);
    target.location.assign(resume);
  }, [
    embedInDrawer,
    uid,
    contactName,
    contactEmail,
    contactPhone,
    serviceName,
    bookingTime,
  ]);

  // 3DS / Apple Pay return_url is the full checkout page. If that lands
  // inside the drawer iframe, promote it to the top window.
  useEffect(() => {
    if (embedInDrawer) return;
    if (typeof window === 'undefined') return;
    if (window.top && window.top !== window) {
      window.top.location.replace(window.location.href);
    }
  }, [embedInDrawer]);

  useEffect(() => {
    if (!embedInDrawer) return;
    document.documentElement.classList.add('checkout-embed');
    document.body.classList.add('checkout-embed');
    return () => {
      document.documentElement.classList.remove('checkout-embed');
      document.body.classList.remove('checkout-embed');
    };
  }, [embedInDrawer]);

  const markConfirmed = useCallback(
    (result: CheckoutApplePayConfirmed | CheckoutConfirmed) => {
      setConfirmed({
        name: result.name || contactName || name,
        calWarning: result.calWarning,
        contact: result.contact,
      });
      if (embedInDrawer && window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: 'sadie-checkout:confirmed' },
          window.location.origin
        );
      }
    },
    [contactName, name, embedInDrawer]
  );

  useEffect(() => {
    if (!embedInDrawer) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'sadie-checkout:go-back') return;
      if (payPhase === 'card') {
        goBackToPayChoice();
        return;
      }
      if (payPhase === 'choose') {
        setPayPhase('details');
        return;
      }
      window.parent.postMessage(
        { type: 'sadie-checkout:back-to-calendar' },
        window.location.origin
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embedInDrawer, payPhase, goBackToPayChoice]);

  const appointmentWhen = useMemo(
    () => (bookingTime ? formatAppointmentWhen(bookingTime, endTime) : null),
    [bookingTime, endTime]
  );
  const serviceLabel = useMemo(
    () => formatServiceTitleForDisplay(serviceName),
    [serviceName]
  );

  const analyticsService = useMemo(
    () => analyticsServiceLabel(serviceName),
    [serviceName]
  );

  // Funnel: /checkout painted (abandon vs convert measured from here).
  useEffect(() => {
    if (!uid) return;
    trackCheckoutEvent(BOOKING_ANALYTICS_EVENTS.CHECKOUT_VIEWED, {
      service: analyticsService,
      alreadyExpired: initialHoldExpired,
    });
    // Once per mount / uid — do not re-fire when service name hydrates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [uid]);

  // Funnel: hold expired on this page (local timer or server flip).
  const expiredTrackedRef = useRef(false);
  useEffect(() => {
    if (!holdExpired || expiredTrackedRef.current) return;
    expiredTrackedRef.current = true;
    trackCheckoutEvent(BOOKING_ANALYTICS_EVENTS.CHECKOUT_EXPIRED, {
      service: analyticsService,
    });
  }, [holdExpired, analyticsService]);

  // Poll the hold row so a cron-driven `canceled_by_system` flip disables
  // checkout even if the local timer hasn't ticked yet. Init is fire-and-
  // forget before navigation, so retry quickly until the row appears.
  // Stop polling once the hold is gone/expired — abandoned checkout tabs
  // otherwise hit Postgres forever (Chrome throttles background timers to
  // ~60s, which is enough to keep Neon from scaling to zero).
  useEffect(() => {
    if (!uid || holdExpired) return;

    let cancelled = false;
    let foundHold = Boolean(initialHoldCreatedAt);
    let missCount = 0;
    let pollId = 0;

    const stopPolling = () => {
      window.clearInterval(pollId);
      pollId = 0;
    };

    const refreshHold = async () => {
      try {
        const res = await fetch(
          `/api/booking/hold?uid=${encodeURIComponent(uid)}`,
          {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            redirect: 'manual',
          }
        );
        if (cancelled) return;

        if (res.status === 404) {
          missCount += 1;
          // Hold was known then vanished (released / canceled) — stop.
          // Or init never produced a row after a short wait — stop so a
          // forgotten tab cannot pin the database awake.
          if (foundHold || missCount >= 45) {
            setHoldExpired(true);
            stopPolling();
          }
          return;
        }

        if (!res.ok) return;

        missCount = 0;
        const data = (await res.json()) as {
          createdAt?: string | null;
          expired?: boolean;
          bookingTime?: string | null;
          endTime?: string | null;
          serviceName?: string | null;
        };
        if (data.createdAt) {
          setHoldCreatedAt(data.createdAt);
          if (!foundHold) {
            foundHold = true;
            stopPolling();
            pollId = window.setInterval(refreshHold, 30_000);
          }
        }
        if (data.expired) {
          setHoldExpired(true);
          stopPolling();
          return;
        }
        if (data.bookingTime) setBookingTime(data.bookingTime);
        if (data.endTime !== undefined) setEndTime(data.endTime ?? null);
        if (data.serviceName) setServiceName(data.serviceName);
        if (
          typeof (data as { quotedServicePriceCents?: unknown })
            .quotedServicePriceCents === 'number'
        ) {
          setQuotedServicePriceCents(
            (data as { quotedServicePriceCents: number }).quotedServicePriceCents
          );
        }
      } catch {
        // Non-fatal — the local countdown still enforces the window.
      }
    };

    refreshHold();
    pollId = window.setInterval(refreshHold, foundHold ? 30_000 : 2_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [uid, initialHoldCreatedAt, holdExpired]);

  // Countdown from `appointments.created_at` using CHECKOUT_HOLD_SECONDS.
  useEffect(() => {
    if (!holdCreatedAt) {
      setCountdownLabel('');
      return;
    }
    if (holdExpired) {
      setCountdownLabel('00:00');
      return;
    }

    const tick = () => {
      const remaining = holdDeadlineMs(holdCreatedAt) - Date.now();
      if (remaining <= 0) {
        setHoldExpired(true);
        setCountdownLabel('00:00');
      } else {
        setCountdownLabel(formatCountdownMmSs(remaining));
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [holdCreatedAt, holdExpired]);

  // When the local countdown expires, release the Cal hold immediately so
  // the slot reopens even if the QStash delayed job never fired. Wait for
  // success (plus a short settle) before offering "return to calendar" —
  // a 180‑min Saturday service often has only one start time; returning
  // while cancel is in flight makes the whole day look empty.
  useEffect(() => {
    if (!holdExpired || !uid) return;

    let cancelled = false;
    setHoldReleaseState('releasing');

    (async () => {
      let releasedOk = false;
      try {
        const res = await fetch('/api/booking/release-hold', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ calBookingUid: uid }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          released?: boolean;
          skipped?: string;
        } | null;
        // QStash may have won the race — skipped status_canceled_* still means free.
        const skipped = typeof data?.skipped === 'string' ? data.skipped : '';
        releasedOk =
          res.ok &&
          (data?.released === true ||
            skipped.startsWith('status_canceled') ||
            skipped === 'not_found' ||
            skipped === 'appointment_not_found');
      } catch {
        // Cron sweep still clears leftovers.
      }

      if (cancelled) return;

      try {
        const res = await fetch(
          `/api/booking/hold?uid=${encodeURIComponent(uid)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = (await res.json()) as { expired?: boolean };
          if (data.expired) setHoldExpired(true);
        }
      } catch {
        /* ignore */
      }

      if (cancelled) return;

      if (releasedOk) {
        // Brief settle so Cal's public slots cache can catch up with cancel.
        await new Promise((r) => window.setTimeout(r, 1500));
        if (!cancelled) setHoldReleaseState('released');
      } else {
        setHoldReleaseState('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [holdExpired, uid]);

  // Deferred SetupIntent: mount Payment Element without a client secret so
  // a failed CVC/ZIP reject can retry without remounting (and wiping) the form.
  // Each submit mints a fresh SetupIntent and confirmSetup uses the same Elements.
  useEffect(() => {
    if (holdExpired || threeDsSetupIntentId) return;

    if (!stripePromise) {
      setBootstrapError(
        'Payment system is not configured. Please contact the studio to confirm your booking.'
      );
      return;
    }
    if (!uid) {
      setBootstrapError(
        'Missing booking reference in the URL. Please re-open this page from your booking confirmation email.'
      );
    }
  }, [uid, holdExpired, threeDsSetupIntentId]);

  const payNow = paymentTiming === 'pay_now';

  const setupApplePayOptions: StripeElementsOptions = useMemo(
    () => ({
      mode: 'setup',
      currency: 'usd',
      paymentMethodTypes: ['card'],
      setupFutureUsage: 'off_session',
      appearance: STRIPE_APPEARANCE,
    }),
    []
  );

  const paymentApplePayOptions: StripeElementsOptions = useMemo(() => {
    const amount =
      quotedServicePriceCents && quotedServicePriceCents > 0
        ? quotedServicePriceCents
        : 50;
    return {
      mode: 'payment',
      amount,
      currency: 'usd',
      paymentMethodTypes: ['card'],
      setupFutureUsage: 'off_session',
      appearance: STRIPE_APPEARANCE,
    };
  }, [quotedServicePriceCents]);

  const cardElementsOptions: StripeElementsOptions = useMemo(() => {
    if (payNow) {
      const amount =
        quotedServicePriceCents && quotedServicePriceCents > 0
          ? quotedServicePriceCents
          : 50;
      return {
        mode: 'payment' as const,
        amount,
        currency: 'usd',
        appearance: STRIPE_APPEARANCE,
        paymentMethodTypes: ['card'],
        setupFutureUsage: 'off_session',
      };
    }
    return {
      mode: 'setup' as const,
      currency: 'usd',
      appearance: STRIPE_APPEARANCE,
      paymentMethodTypes: ['card'],
      setupFutureUsage: 'off_session',
    };
  }, [payNow, quotedServicePriceCents]);

  return (
    <main
      className={
        embedInDrawer
          ? 'flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#F5F3F0] px-4 py-3 font-sans'
          : 'flex min-h-screen w-full flex-col items-center bg-[#FAF9F6] px-4 py-12 font-sans sm:py-16'
      }
    >
      {embedInDrawer ? null : <BrandHeader />}

      <section
        className={
          embedInDrawer
            ? 'flex min-h-0 w-full max-w-md flex-1 flex-col overflow-hidden'
            : 'mt-10 w-full max-w-md'
        }
      >
        {holdExpired ? (
          <ExpiredHoldCard releaseState={holdReleaseState} />
        ) : threeDsPaymentIntentId ? (
          <CheckoutThreeDSResume
            uid={uid}
            name={name}
            email={email}
            paymentIntentId={threeDsPaymentIntentId}
          />
        ) : threeDsSetupIntentId ? (
          <CheckoutThreeDSResume
            uid={uid}
            name={name}
            email={email}
            setupIntentId={threeDsSetupIntentId}
          />
        ) : bootstrapError ? (
          <ErrorCard message={bootstrapError} />
        ) : !stripePromise || !uid ? (
          <LoadingCard />
        ) : confirmed ? (
          <SuccessCard
            name={confirmed.name}
            calWarning={confirmed.calWarning}
            contact={confirmed.contact}
          />
        ) : (
          <>
            <CheckoutHoldSummary
              appointmentWhen={appointmentWhen}
              serviceLabel={serviceLabel}
              countdownLabel={countdownLabel}
              compact={embedInDrawer}
            />
            {payPhase === 'details' ? (
              <CheckoutDetailsForm
                uid={uid}
                name={contactName}
                phone={contactPhone}
                email={contactEmail}
                compact={embedInDrawer}
                onCancel={() => {
                  window.parent.postMessage(
                    { type: 'sadie-checkout:back-to-calendar' },
                    window.location.origin
                  );
                }}
                onSaved={(next) => {
                  setContactName(next.name);
                  setContactPhone(next.phone);
                  setContactEmail(next.email);
                  setPayPhase('choose');
                }}
              />
            ) : payPhase === 'choose' ? (
              <CheckoutPayChoice
                uid={uid}
                name={contactName}
                email={contactEmail}
                serviceTitle={serviceLabel || analyticsService}
                paymentTiming={paymentTiming}
                onPaymentTimingChange={(next) => {
                  setPaymentTiming(next);
                  setApplePayError(null);
                }}
                quotedServicePriceCents={quotedServicePriceCents}
                compact={embedInDrawer}
                mountApplePay={mountApplePay}
                applePayAvailable={applePayAvailable}
                applePaySubmitting={applePaySubmitting}
                applePayError={applePayError}
                setupApplePayOptions={setupApplePayOptions}
                paymentApplePayOptions={paymentApplePayOptions}
                onApplePayResolved={onApplePayResolved}
                onApplePaySubmittingChange={setApplePaySubmitting}
                onApplePayError={setApplePayError}
                onConfirmed={markConfirmed}
                onEditDetails={
                  embedInDrawer ? () => setPayPhase('details') : undefined
                }
                onReturnToDrawer={
                  embedInDrawer ? undefined : goBackToPayChoice
                }
                onPayWithCard={() => {
                  setApplePayError(null);
                  if (embedInDrawer) {
                    navigateToCardCheckout(paymentTiming);
                    return;
                  }
                  setPayPhase('card');
                }}
              />
            ) : (
              <Elements
                key={payNow ? 'card-payment' : 'card-setup'}
                stripe={stripePromise}
                options={cardElementsOptions}
              >
                <CheckoutForm
                  uid={uid}
                  name={contactName}
                  email={contactEmail}
                  holdExpired={holdExpired}
                  service={analyticsService}
                  payNow={payNow}
                  quotedServicePriceCents={quotedServicePriceCents}
                  onBack={goBackToPayChoice}
                  onConfirmed={(result) =>
                    markConfirmed({ ...result, name: contactName })
                  }
                />
              </Elements>
            )}
          </>
        )}
      </section>

      {embedInDrawer ? null : <Footnote />}
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header / footer chrome
// ──────────────────────────────────────────────────────────────────────────
function CheckoutDetailsForm({
  uid,
  name,
  phone,
  email,
  compact,
  onCancel,
  onSaved,
}: {
  uid: string;
  name: string;
  phone: string;
  email: string;
  compact: boolean;
  onCancel: () => void;
  onSaved: (next: { name: string; phone: string; email: string }) => void;
}) {
  const parts = name.trim().split(/\s+/);
  const [firstName, setFirstName] = useState(parts[0] || '');
  const [lastName, setLastName] = useState(
    parts.length > 1 ? parts.slice(1).join(' ') : ''
  );
  const [phoneValue, setPhoneValue] = useState(
    phone ? formatUsPhoneAsYouType(phone) : ''
  );
  const [emailValue, setEmailValue] = useState(email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!firstName.trim()) {
      setError('Enter your first name.');
      return;
    }
    if (!parseClientPhone(phoneValue)) {
      setError(clientPhoneValidationMessage());
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/booking/update-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calBookingUid: uid,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phoneValue.trim(),
          email: emailValue.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        name?: string;
        email?: string;
        message?: string;
      } | null;
      if (!res.ok) {
        setError(data?.message || 'Could not save your details.');
        return;
      }
      onSaved({
        name: data?.name || `${firstName.trim()} ${lastName.trim()}`.trim(),
        phone: phoneValue,
        email: data?.email || emailValue.trim(),
      });
    } catch {
      setError('Could not save your details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className={
        compact
          ? 'rounded-2xl border border-stone-200 bg-white p-5 shadow-sm'
          : 'rounded-2xl border border-stone-200 bg-white p-8 shadow-sm'
      }
    >
      <h2 className="font-serif text-2xl text-stone-900">Your details</h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">
        Fix a name or number — your time slot stays held.
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
            First name
          </span>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            required
            className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-400"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
            Last name
          </span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-400"
          />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
          Phone
        </span>
        <input
          type="tel"
          inputMode="numeric"
          value={phoneValue}
          onChange={(e) => setPhoneValue(formatUsPhoneAsYouType(e.target.value))}
          autoComplete="tel"
          maxLength={14}
          placeholder="(555) 123-4567"
          required
          className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-400"
        />
      </label>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
          Email <span className="normal-case tracking-normal text-stone-400">(optional)</span>
        </span>
        <input
          type="email"
          value={emailValue}
          onChange={(e) => setEmailValue(e.target.value)}
          autoComplete="email"
          className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-400"
        />
      </label>
      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={saving}
        className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-stone-900 px-5 py-3 text-sm font-medium text-stone-50 hover:bg-stone-800 disabled:bg-stone-400"
      >
        {saving ? 'Saving…' : 'Continue to payment'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full text-center text-sm text-stone-500 underline-offset-2 hover:underline"
      >
        Back to calendar
      </button>
    </form>
  );
}

function CheckoutPayChoice({
  uid,
  name,
  email,
  serviceTitle,
  paymentTiming,
  onPaymentTimingChange,
  quotedServicePriceCents,
  compact = false,
  mountApplePay,
  applePayAvailable,
  applePaySubmitting,
  applePayError,
  setupApplePayOptions,
  paymentApplePayOptions,
  onApplePayResolved,
  onApplePaySubmittingChange,
  onApplePayError,
  onConfirmed,
  onPayWithCard,
  onEditDetails,
  onReturnToDrawer,
}: {
  uid: string;
  name: string;
  email: string;
  serviceTitle: string;
  paymentTiming: BookingPaymentTiming;
  onPaymentTimingChange: (next: BookingPaymentTiming) => void;
  quotedServicePriceCents: number | null;
  compact?: boolean;
  mountApplePay: boolean;
  applePayAvailable: boolean | null;
  applePaySubmitting: boolean;
  applePayError: string | null;
  setupApplePayOptions: StripeElementsOptions;
  paymentApplePayOptions: StripeElementsOptions;
  onApplePayResolved: (available: boolean) => void;
  onApplePaySubmittingChange: (v: boolean) => void;
  onApplePayError: (message: string | null) => void;
  onConfirmed: (result: CheckoutApplePayConfirmed) => void;
  onPayWithCard: () => void;
  onEditDetails?: () => void;
  onReturnToDrawer?: () => void;
}) {
  const payNow = paymentTiming === 'pay_now';
  const priceLabel = formatUsdFromCents(quotedServicePriceCents);
  const showApplePaySlot = mountApplePay && applePayAvailable !== false;
  const showPrimaryCard = !mountApplePay || applePayAvailable === false;

  return (
    <div
      className={
        compact
          ? 'flex min-h-0 flex-1 flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm shadow-stone-900/[0.03]'
          : 'rounded-2xl border border-stone-200 bg-white p-8 shadow-sm shadow-stone-900/[0.03] sm:p-10'
      }
    >
      <h2
        className={
          compact
            ? 'font-serif text-xl text-stone-900'
            : 'font-serif text-2xl text-stone-900'
        }
      >
        How would you like to pay?
      </h2>
      {onEditDetails ? (
        <button
          type="button"
          onClick={onEditDetails}
          className={
            compact
              ? 'mt-1 text-left text-sm text-stone-500 underline-offset-2 hover:underline'
              : 'mt-2 text-left text-sm text-stone-500 underline-offset-2 hover:underline'
          }
        >
          Edit name or phone
        </button>
      ) : null}
      {compact ? null : (
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          Choose now or later — a card on file is required either way.
        </p>
      )}

      <div
        className={
          compact
            ? 'mt-3 flex items-baseline justify-between border-b border-stone-100 pb-3'
            : 'mt-6 flex items-baseline justify-between border-b border-stone-100 pb-4'
        }
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
          Due today
        </p>
        <p
          className={
            compact
              ? 'font-serif text-xl text-stone-900'
              : 'font-serif text-2xl text-stone-900'
          }
        >
          {payNow ? priceLabel || 'Pay now' : '$0'}
        </p>
      </div>

      <fieldset
        disabled={applePaySubmitting}
        className={compact ? 'mt-3 space-y-2' : 'mt-5 space-y-2.5'}
      >
        <legend className="sr-only">Payment timing</legend>
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-xl border transition-colors ${
            compact ? 'px-3 py-2.5' : 'px-4 py-3.5'
          } ${
            paymentTiming === 'pay_later'
              ? 'border-stone-900 bg-stone-50'
              : 'border-stone-200 bg-white hover:border-stone-300'
          }`}
        >
          <input
            type="radio"
            name="checkoutPaymentTiming"
            value="pay_later"
            checked={paymentTiming === 'pay_later'}
            onChange={() => onPaymentTimingChange('pay_later')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-stone-900">
              Pay later in studio
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
              Card saved to hold — pay at your visit
            </span>
          </span>
        </label>
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-xl border transition-colors ${
            compact ? 'px-3 py-2.5' : 'px-4 py-3.5'
          } ${
            paymentTiming === 'pay_now'
              ? 'border-stone-900 bg-stone-50'
              : 'border-stone-200 bg-white hover:border-stone-300'
          }`}
        >
          <input
            type="radio"
            name="checkoutPaymentTiming"
            value="pay_now"
            checked={paymentTiming === 'pay_now'}
            onChange={() => onPaymentTimingChange('pay_now')}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-stone-900">
              Pay now in full
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
              Save time at your appointment
              {priceLabel ? ` — charged ${priceLabel} now` : ''}
            </span>
          </span>
        </label>
      </fieldset>

      <p
        className={
          compact
            ? 'mt-3 text-[11px] leading-snug text-stone-400'
            : 'mt-5 text-xs leading-relaxed text-stone-400'
        }
      >
        24+ hours notice to cancel or reschedule. Inside 24 hours may be
        charged up to 50%; no-shows (or cancels within 2 hours) may be charged
        100%. A card on file is required either way.
      </p>

      {showApplePaySlot && stripePromise ? (
        <div
          className={`relative w-full ${compact ? 'mt-4 min-h-11' : 'mt-6 min-h-12'}`}
        >
          <div className="absolute inset-0">
            <Elements stripe={stripePromise} options={setupApplePayOptions}>
              <CheckoutApplePayHost
                active={paymentTiming === 'pay_later'}
                paymentTiming="pay_later"
                uid={uid}
                name={name}
                email={email}
                serviceTitle={serviceTitle}
                submitting={applePaySubmitting}
                onSubmittingChange={onApplePaySubmittingChange}
                onError={onApplePayError}
                onConfirmed={onConfirmed}
                onApplePayResolved={onApplePayResolved}
              />
            </Elements>
          </div>
          <div className="absolute inset-0">
            <Elements stripe={stripePromise} options={paymentApplePayOptions}>
              <CheckoutApplePayHost
                active={paymentTiming === 'pay_now'}
                paymentTiming="pay_now"
                uid={uid}
                name={name}
                email={email}
                serviceTitle={serviceTitle}
                submitting={applePaySubmitting}
                onSubmittingChange={onApplePaySubmittingChange}
                onError={onApplePayError}
                onConfirmed={onConfirmed}
                onApplePayResolved={onApplePayResolved}
              />
            </Elements>
          </div>
        </div>
      ) : null}

      {applePayError ? (
        <div
          role="alert"
          className="mt-5 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800"
        >
          {applePayError}
        </div>
      ) : null}

      {showApplePaySlot ? (
        <button
          type="button"
          disabled={applePaySubmitting}
          onClick={onPayWithCard}
          className="mt-4 w-full text-center text-sm font-medium text-stone-500 transition-colors hover:text-stone-800 disabled:opacity-50"
        >
          Pay with card instead
        </button>
      ) : null}

      {showPrimaryCard ? (
        <button
          type="button"
          disabled={applePaySubmitting}
          onClick={onPayWithCard}
          className={`${
            compact ? 'mt-4 py-2.5' : 'mt-6 py-3'
          } inline-flex w-full items-center justify-center gap-2 rounded-md bg-stone-900 px-5 text-sm font-medium tracking-wide text-stone-50 shadow-none transition-colors hover:bg-stone-800 active:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-400`}
        >
          {payNow ? 'Pay with card' : 'Continue with card'}
        </button>
      ) : null}

      {onReturnToDrawer ? (
        <button
          type="button"
          disabled={applePaySubmitting}
          onClick={onReturnToDrawer}
          className={`${
            compact ? 'mt-3 py-2.5' : 'mt-3 py-3'
          } inline-flex w-full items-center justify-center rounded-md border border-stone-300 bg-white px-5 text-sm font-medium tracking-wide text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Cancel transaction
        </button>
      ) : null}

      <p
        className={
          compact
            ? 'mt-2.5 text-center text-[11px] leading-snug text-stone-400'
            : 'mt-4 text-center text-[11px] leading-relaxed text-stone-400'
        }
      >
        {payNow
          ? 'Paid in full online. Cancellation policy still applies to refunds.'
          : 'Your card will only be charged for no-shows or late cancellations, per studio policy.'}
      </p>
    </div>
  );
}

function BrandHeader() {
  return (
    <div className="text-center">
      <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
        Studio · Checkout
      </p>
      <h1 className="mt-2 font-serif text-4xl text-stone-900 sm:text-5xl">
        Sadie Marie
      </h1>
    </div>
  );
}

function Footnote() {
  return (
    <p className="mt-10 max-w-md text-center text-[11px] leading-relaxed tracking-wide text-stone-400">
      Payments are processed securely by Stripe. Sadie Marie
      never sees or stores your full card number.
    </p>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 3DS return — auto-finalise after Stripe redirect (no second submit)
// ──────────────────────────────────────────────────────────────────────────
function CheckoutThreeDSResume({
  uid,
  name,
  email,
  setupIntentId,
  paymentIntentId,
}: {
  uid: string;
  name: string;
  email: string;
  setupIntentId?: string;
  paymentIntentId?: string;
}) {
  const [submitting, setSubmitting] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    calWarning: string | null;
    contact: { sms: boolean; email: boolean };
  } | null>(null);
  const resumeStartedRef = useRef(false);
  const intentKey = paymentIntentId || setupIntentId || '';

  useEffect(() => {
    if (!uid || !intentKey || resumeStartedRef.current) return;
    resumeStartedRef.current = true;

    (async () => {
      try {
        const result = await callBookingConfirm({
          ...(paymentIntentId
            ? { paymentIntentId }
            : { setupIntentId: setupIntentId! }),
          calBookingUid: uid,
          name,
          email,
        });
        clearStripeRedirectParams(uid, name, email);
        setConfirmed({
          calWarning: result.calWarning,
          contact: result.contact,
        });
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : paymentIntentId
              ? 'Your payment went through but we could not finalise the appointment. Please contact the studio.'
              : 'Your card was saved but we could not finalise the appointment. Please contact the studio.'
        );
      } finally {
        setSubmitting(false);
      }
    })();
  }, [uid, name, email, intentKey, paymentIntentId, setupIntentId]);

  if (confirmed) {
    return (
      <SuccessCard
        name={name}
        calWarning={confirmed.calWarning}
        contact={confirmed.contact}
      />
    );
  }

  if (submitError) {
    return <ErrorCard message={submitError} />;
  }

  if (submitting) {
    return <LoadingCard label="Confirming your appointment…" />;
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Form (inside Elements provider) — owns confirmSetup + /api/booking/confirm
// ──────────────────────────────────────────────────────────────────────────
interface FormProps {
  uid: string;
  name: string;
  email: string;
  holdExpired: boolean;
  service: string;
  payNow: boolean;
  quotedServicePriceCents: number | null;
  onBack?: () => void;
  /** 3DS / bank redirect target. /book when the card form is inlined on the phone booker. */
  returnPath?: string;
  onConfirmed: (result: {
    calWarning: string | null;
    contact: { sms: boolean; email: boolean };
  }) => void;
}

function CheckoutHoldSummary({
  appointmentWhen,
  serviceLabel,
  countdownLabel,
  compact = false,
}: {
  appointmentWhen: { date: string; timeRange: string } | null;
  serviceLabel: string | null;
  countdownLabel: string;
  compact?: boolean;
}) {
  if (!appointmentWhen && !countdownLabel) return null;

  if (compact) {
    return (
      <div className="mb-3 shrink-0 rounded-md border border-stone-200 bg-white px-3 py-2.5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          {appointmentWhen ? (
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
                Appointment
              </p>
              <p className="mt-1 font-serif text-lg leading-snug text-stone-900">
                {appointmentWhen.date}
              </p>
              <p className="mt-0.5 text-sm font-medium tabular-nums text-stone-700">
                {appointmentWhen.timeRange}
              </p>
              {serviceLabel ? (
                <p className="mt-0.5 truncate text-xs text-stone-500">
                  {serviceLabel}
                </p>
              ) : null}
            </div>
          ) : null}
          {countdownLabel ? (
            <div className="shrink-0 text-right" aria-live="polite">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                Time remaining
              </p>
              <p className="mt-1 font-mono text-lg font-medium tabular-nums text-stone-900">
                {countdownLabel}
              </p>
            </div>
          ) : null}
        </div>
        {countdownLabel ? (
          <p className="mt-2 text-[11px] leading-snug text-stone-400">
            Complete checkout within {checkoutHoldDurationLabel()} to hold
            your time slot.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mb-6">
      {appointmentWhen && (
        <div className="rounded-md border border-stone-200 bg-white px-4 py-4 shadow-sm">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
            Appointment
          </p>
          <p className="mt-2 font-serif text-xl leading-snug text-stone-900">
            {appointmentWhen.date}
          </p>
          <p className="mt-1 text-sm font-medium tabular-nums text-stone-700">
            {appointmentWhen.timeRange}
          </p>
          {serviceLabel ? (
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              {serviceLabel}
            </p>
          ) : null}
        </div>
      )}

      {countdownLabel ? (
        <>
          <div
            className={`flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-4 py-3 ${
              appointmentWhen ? 'mt-3' : ''
            }`}
            aria-live="polite"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
              Time remaining
            </p>
            <p className="font-mono text-lg font-medium tabular-nums text-stone-900">
              {countdownLabel}
            </p>
          </div>
          <p className="mt-2 text-center text-[11px] text-stone-400">
            Complete checkout within {checkoutHoldDurationLabel()} to hold
            your time slot.
          </p>
        </>
      ) : null}
    </div>
  );
}

export function CheckoutForm({
  uid,
  name,
  email,
  holdExpired,
  service,
  payNow,
  quotedServicePriceCents,
  onBack,
  returnPath = '/checkout',
  onConfirmed,
}: FormProps) {
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [submitLabel, setSubmitLabel] = useState(
    payNow ? 'Processing payment…' : 'Saving your card…'
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    calWarning: string | null;
    contact: { sms: boolean; email: boolean };
  } | null>(null);

  const ready = stripe !== null && elements !== null;
  const searchParams = useSearchParams();
  const resumeStartedRef = useRef(false);

  const finalizeBooking = useCallback(
    async (intent: { setupIntentId?: string; paymentIntentId?: string }) => {
      setSubmitting(true);
      setSubmitLabel('Confirming your appointment…');
      setSubmitError(null);
      try {
        const result = await callBookingConfirm({
          ...intent,
          calBookingUid: uid,
          name,
          email,
        });
        clearStripeRedirectParams(uid, name, email);
        onConfirmed({
          calWarning: result.calWarning,
          contact: result.contact,
        });
        setConfirmed({
          calWarning: result.calWarning,
          contact: result.contact,
        });
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : intent.paymentIntentId
              ? 'Your payment went through but we could not finalise the appointment. Please contact the studio.'
              : 'Your card was saved but we could not finalise the appointment. Please contact the studio.'
        );
      } finally {
        setSubmitting(false);
      }
    },
    [uid, name, email, onConfirmed]
  );

  // In-page 3DS return (rare) or bookmarked return URL — same auto-finalise
  // path as the full-page redirect handled by CheckoutThreeDSResume.
  useEffect(() => {
    if (holdExpired || !uid || resumeStartedRef.current || confirmed) {
      return;
    }
    const redirectStatus = searchParams.get('redirect_status');
    const setupIntentId = searchParams.get('setup_intent')?.trim() ?? '';
    const paymentIntentId = searchParams.get('payment_intent')?.trim() ?? '';
    if (redirectStatus !== 'succeeded') return;
    if (paymentIntentId.startsWith('pi_')) {
      resumeStartedRef.current = true;
      void finalizeBooking({ paymentIntentId });
      return;
    }
    if (setupIntentId.startsWith('seti_')) {
      resumeStartedRef.current = true;
      void finalizeBooking({ setupIntentId });
    }
  }, [
    holdExpired,
    uid,
    confirmed,
    searchParams,
    finalizeBooking,
  ]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (holdExpired || !stripe || !elements || submitting) return;

    trackCheckoutEvent(BOOKING_ANALYTICS_EVENTS.CHECKOUT_PAYMENT_ATTEMPT, {
      service,
      payment_timing: payNow ? 'pay_now' : 'pay_later',
    });

    setSubmitting(true);
    setSubmitLabel(payNow ? 'Processing payment…' : 'Saving your card…');
    setSubmitError(null);

    try {
      const { error: elementsSubmitError } = await elements.submit();
      if (elementsSubmitError) {
        setSubmitError(friendlyStripeSetupError(elementsSubmitError));
        return;
      }

      setSubmitLabel('Connecting securely…');
      const intentPath = payNow
        ? '/api/stripe/create-booking-payment-intent'
        : '/api/stripe/create-setup-intent';
      let clientSecret: string;
      try {
        const res = await fetchWithTimeout(
          intentPath,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              calBookingUid: uid,
              ...(name ? { name } : {}),
              ...(email ? { email } : {}),
            }),
          },
          30_000
        );
        const payload = (await res.json().catch(() => null)) as
          | { clientSecret?: string; error?: string; message?: string }
          | null;
        if (!res.ok || !payload?.clientSecret) {
          throw new Error(
            payload?.message ??
              payload?.error ??
              `Could not initialise checkout (HTTP ${res.status})`
          );
        }
        clientSecret = payload.clientSecret;
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : 'Could not initialise checkout. Please try again.'
        );
        return;
      }

      const returnUrl = new URL(returnPath, window.location.origin);
      returnUrl.searchParams.set('uid', uid);
      if (name) returnUrl.searchParams.set('name', name);
      if (email) returnUrl.searchParams.set('email', email);
      if (payNow) returnUrl.searchParams.set('payMode', 'now');

      setSubmitLabel('Verifying with your bank…');
      setKeepHoldThroughUnload(true);
      if (payNow) {
        const { error, paymentIntent } = await stripe.confirmPayment({
          elements,
          clientSecret,
          confirmParams: {
            return_url: returnUrl.toString(),
          },
          redirect: 'if_required',
        });

        if (error) {
          setKeepHoldThroughUnload(false);
          setSubmitError(friendlyStripeSetupError(error));
          return;
        }

        let finalPi = paymentIntent;
        if (finalPi?.status === 'requires_action') {
          const next = await stripe.handleNextAction({ clientSecret });
          if (next.error) {
            setKeepHoldThroughUnload(false);
            setSubmitError(friendlyStripeSetupError(next.error));
            return;
          }
          finalPi = next.paymentIntent ?? finalPi;
        }

        if (!finalPi || finalPi.status !== 'succeeded') {
          setKeepHoldThroughUnload(false);
          setSubmitError(
            'Your payment could not be confirmed. Please check the details and try again.'
          );
          return;
        }

        setSubmitLabel('Confirming your appointment…');
        await finalizeBooking({ paymentIntentId: finalPi.id });
        setKeepHoldThroughUnload(false);
      } else {
        const { error, setupIntent } = await stripe.confirmSetup({
          elements,
          clientSecret,
          confirmParams: {
            return_url: returnUrl.toString(),
          },
          redirect: 'if_required',
        });

        if (error) {
          setKeepHoldThroughUnload(false);
          setSubmitError(friendlyStripeSetupError(error));
          return;
        }

        let finalIntent = setupIntent;
        if (finalIntent?.status === 'requires_action') {
          const next = await stripe.handleNextAction({ clientSecret });
          if (next.error) {
            setKeepHoldThroughUnload(false);
            setSubmitError(friendlyStripeSetupError(next.error));
            return;
          }
          finalIntent = next.setupIntent ?? finalIntent;
        }

        if (!finalIntent || finalIntent.status !== 'succeeded') {
          setKeepHoldThroughUnload(false);
          setSubmitError(
            'Your card could not be confirmed. Please check the details and try again — if your bank asks to verify the charge, complete that prompt and retry.'
          );
          return;
        }

        setSubmitLabel('Confirming your appointment…');
        await finalizeBooking({ setupIntentId: finalIntent.id });
        setKeepHoldThroughUnload(false);
      }
    } catch (err) {
      setKeepHoldThroughUnload(false);
      setSubmitError(
        err instanceof Error
          ? err.message
          : payNow
            ? 'Something went wrong processing your payment. Please try again.'
            : 'Something went wrong saving your card. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return null;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm shadow-stone-900/[0.03] sm:p-10"
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="mb-4 text-left text-xs font-medium tracking-wide text-stone-500 transition-colors hover:text-stone-800 disabled:opacity-50"
        >
          ← Back to payment options
        </button>
      ) : null}
      <h2 className="font-serif text-2xl text-stone-900">
        {payNow ? 'Pay for your appointment' : 'Secure your appointment'}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">
        {payNow ? (
          <>
            You&rsquo;ll be charged now for the full service. Your card stays on
            file for cancellation policy if needed.
            {quotedServicePriceCents && quotedServicePriceCents > 0 ? (
              <span className="mt-1 block font-medium text-stone-700">
                Charged today:{' '}
                {new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency: 'USD',
                }).format(quotedServicePriceCents / 100)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            We&rsquo;ll save your card on file to confirm the booking.
            <span className="mt-1 block font-medium text-stone-700">
              No charge today.
            </span>
          </>
        )}
      </p>

      {name && (
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
            Booking for
          </p>
          <p className="mt-1 text-sm font-medium text-stone-900">{name}</p>
          {email ? (
            <p className="text-xs text-stone-500">{email}</p>
          ) : null}
        </div>
      )}

      <fieldset
        disabled={holdExpired || submitting}
        className="mt-6 disabled:pointer-events-none disabled:opacity-50"
      >
        <PaymentElement
          options={{
            layout: { type: 'tabs', defaultCollapsed: false },
            // Pre-fill name + email when Cal handed them to us in the
            // URL so the client doesn't retype. When they're missing
            // (Cal's embed payload didn't expose them, or the visitor
            // navigated here from elsewhere) we leave defaultValues
            // undefined so the Element renders the fields blank and
            // `fields.billingDetails.{name,email}: 'auto'` (Stripe's
            // default) collects them inline — no extra UI needed.
            defaultValues:
              name || email
                ? {
                    billingDetails: {
                      ...(name ? { name } : {}),
                      ...(email ? { email } : {}),
                    },
                  }
                : undefined,
            fields: {
              billingDetails: {
                name: 'auto',
                email: 'auto',
              },
            },
          }}
        />
      </fieldset>

      {submitError && (
        <div
          role="alert"
          className="mt-5 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800"
        >
          {submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={!ready || submitting || holdExpired}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-stone-900 px-5 py-3 text-sm font-medium tracking-wide text-stone-50 shadow-none transition-colors hover:bg-stone-800 active:bg-stone-900 disabled:cursor-not-allowed disabled:bg-stone-400"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{submitLabel}</span>
          </>
        ) : (
          <>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>{payNow ? 'Pay & confirm' : 'Secure Appointment'}</span>
          </>
        )}
      </button>

      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-stone-300 bg-white px-5 py-3 text-sm font-medium tracking-wide text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel transaction
        </button>
      ) : null}

      <p className="mt-4 text-center text-[11px] leading-relaxed text-stone-400">
        {payNow
          ? 'Paid in full online. Cancellation policy still applies to refunds.'
          : 'Your card will only be charged for no-shows or late cancellations, per studio policy.'}
      </p>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// State cards
// ──────────────────────────────────────────────────────────────────────────
function LoadingCard({ label = 'Preparing your secure checkout' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-stone-200 bg-white p-10 text-center shadow-sm shadow-stone-900/[0.03]">
      <Loader2
        className="h-5 w-5 animate-spin text-stone-400"
        aria-hidden="true"
      />
      <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
        {label}
      </p>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center shadow-sm shadow-stone-900/[0.03] sm:p-10">
      <h2 className="font-serif text-2xl text-rose-900">
        We hit a snag
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-rose-800">{message}</p>
    </div>
  );
}

function ExpiredHoldCard({
  releaseState,
}: {
  releaseState: 'idle' | 'releasing' | 'released' | 'failed';
}) {
  const stillReleasing =
    releaseState === 'idle' || releaseState === 'releasing';
  const canReturn = releaseState === 'released' || releaseState === 'failed';

  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center shadow-sm shadow-stone-900/[0.03] sm:p-10">
      <h2 className="font-serif text-2xl text-rose-900">
        Booking window closed
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-rose-800">
        {HOLD_EXPIRED_MESSAGE}
      </p>
      {stillReleasing ? (
        <p className="mt-4 text-sm text-rose-700">
          Freeing your time on the calendar&hellip;
        </p>
      ) : releaseState === 'released' ? (
        <p className="mt-4 text-sm text-rose-700">
          Your time is free again — pick a new slot to continue.
        </p>
      ) : (
        <p className="mt-4 text-sm text-rose-700">
          If a time still looks unavailable, wait a moment and refresh the
          calendar.
        </p>
      )}
      {canReturn ? (
        <Link
          href="/?cal_refresh=1#services"
          target="_top"
          className="mt-8 inline-flex w-full items-center justify-center rounded-md bg-stone-900 px-5 py-3 text-sm font-medium tracking-wide text-stone-50 transition-colors hover:bg-stone-800"
        >
          Return to booking calendar
        </Link>
      ) : (
        <div
          className="mt-8 inline-flex w-full items-center justify-center rounded-md bg-stone-900/40 px-5 py-3 text-sm font-medium tracking-wide text-stone-50"
          aria-busy="true"
        >
          Freeing your time&hellip;
        </div>
      )}
    </div>
  );
}

function successContactPhrase(contact: { sms: boolean; email: boolean }): string {
  if (contact.sms && contact.email) return 'SMS or email';
  if (contact.sms) return 'SMS';
  if (contact.email) return 'email';
  // Shouldn't happen after the contact-channel gate, but stay graceful.
  return 'messages';
}

function SuccessCard({
  name,
  calWarning,
  contact,
}: {
  name: string;
  calWarning: string | null;
  contact: { sms: boolean; email: boolean };
}) {
  // Be defensive about a missing `name` — the URL may not carry one
  // when Cal's `bookingSuccessful` payload didn't include attendees.
  const firstName = (name || '').trim().split(/\s+/)[0] || '';
  const channel = successContactPhrase(contact);
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm shadow-stone-900/[0.03] sm:p-10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-stone-900 text-stone-50">
        <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
      </div>
      <h2 className="mt-6 font-serif text-3xl text-stone-900">
        {firstName ? `Thank you, ${firstName}.` : 'You\u2019re all set.'}
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-stone-600">
        Your appointment is confirmed. Check your {channel} for the details
        and a link to manage your booking.
      </p>

      {calWarning && (
        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-left text-xs text-amber-900">
          <p className="font-medium">Heads up</p>
          <p className="mt-1 leading-relaxed">
            Your booking is recorded, but we couldn&rsquo;t finalise the calendar
            invite automatically. The studio will confirm with you shortly.
          </p>
        </div>
      )}

      <p className="mt-8 text-[11px] leading-relaxed tracking-wide text-stone-400">
        Questions? Reach out at{' '}
        <a
          href="mailto:mckenna@sadiemarie.co"
          className="underline decoration-stone-300 underline-offset-2 transition-colors hover:text-stone-600"
        >
          mckenna@sadiemarie.co
        </a>
        .
      </p>
    </div>
  );
}
