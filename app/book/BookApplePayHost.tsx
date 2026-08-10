'use client';

/**
 * Apple Pay / Express Checkout for /book review only.
 * Mounted on the review step so earlier steps keep a clean Continue footer.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { track } from '@vercel/analytics';
import {
  ExpressCheckoutElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import type {
  StripeExpressCheckoutElementConfirmEvent,
  StripeExpressCheckoutElementClickEvent,
  StripeExpressCheckoutElementReadyEvent,
  StripeExpressCheckoutElementOptions,
} from '@stripe/stripe-js';

import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
} from '@/lib/booking-analytics';

import styles from './book.module.css';

export function prefersApplePayDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const AP = (
      window as Window & {
        ApplePaySession?: { canMakePayments?: () => boolean };
      }
    ).ApplePaySession;
    if (!AP || typeof AP.canMakePayments !== 'function') return false;
    return AP.canMakePayments();
  } catch {
    return false;
  }
}

function trackBook(
  name: string,
  data?: Record<string, string | number | boolean | null>
) {
  try {
    track(name, data);
  } catch {
    /* ignore */
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  ms: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function friendlyStripeError(error: { message?: string }): string {
  const msg = (error.message || '').trim();
  if (msg) return msg;
  return 'Apple Pay could not save your card. Please try again or pay with card.';
}

export type BookCreatePayload = {
  slug: string;
  start: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string;
  email?: string;
  smsOptIn: boolean;
  source: 'phone_booker' | 'phone_booker_apple_pay';
};

export type BookConfirmed = {
  name: string;
  calWarning: string | null;
  contact: { sms: boolean; email: boolean };
};

type Props = {
  priceLabel: string;
  serviceTitle: string;
  createPayload: Omit<BookCreatePayload, 'source'>;
  submitting: boolean;
  onSubmittingChange: (v: boolean) => void;
  onError: (message: string | null) => void;
  onCreateError: (data: { error?: string; message?: string }) => void;
  onPayWithCard: () => void;
  onConfirmed: (result: BookConfirmed) => void;
  onApplePayResolved?: (available: boolean) => void;
};

const EXPRESS_OPTIONS: StripeExpressCheckoutElementOptions = {
  buttonType: { applePay: 'book' },
  buttonTheme: { applePay: 'black' },
  buttonHeight: 48,
  paymentMethods: {
    applePay: 'auto',
    googlePay: 'never',
    link: 'never',
    paypal: 'never',
    amazonPay: 'never',
    klarna: 'never',
  },
  emailRequired: false,
  phoneNumberRequired: false,
  billingAddressRequired: true,
  business: { name: 'Sadie Marie' },
};

export default function BookApplePayHost({
  priceLabel,
  serviceTitle,
  createPayload,
  submitting,
  onSubmittingChange,
  onError,
  onCreateError,
  onPayWithCard,
  onConfirmed,
  onApplePayResolved,
}: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const prefersApplePay = useMemo(() => prefersApplePayDevice(), []);
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [expressReady, setExpressReady] = useState(false);

  const payloadRef = useRef(createPayload);
  payloadRef.current = createPayload;
  const serviceTitleRef = useRef(serviceTitle);
  serviceTitleRef.current = serviceTitle;

  const onReady = useCallback(
    (event: StripeExpressCheckoutElementReadyEvent) => {
      const available = Boolean(event.availablePaymentMethods?.applePay);
      setExpressReady(true);
      setApplePayAvailable(available);
      onApplePayResolved?.(available);
    },
    [onApplePayResolved]
  );

  useEffect(() => {
    if (!prefersApplePay) onApplePayResolved?.(false);
  }, [prefersApplePay, onApplePayResolved]);

  const onClick = useCallback(
    (event: StripeExpressCheckoutElementClickEvent) => {
      event.resolve({});
    },
    []
  );

  const createHold = useCallback(
    async (source: BookCreatePayload['source']) => {
      const payload = payloadRef.current;
      const res = await fetchWithTimeout(
        '/api/book/create',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...payload, source }),
        },
        45_000
      );
      const data = (await res.json().catch(() => null)) as {
        calBookingUid?: string;
        name?: string;
        email?: string;
        error?: string;
        message?: string;
      } | null;

      if (!res.ok || !data?.calBookingUid) {
        onCreateError(data ?? { message: 'Could not hold that time. Try again.' });
        throw new Error(data?.message || 'Could not hold that time.');
      }
      return data as {
        calBookingUid: string;
        name?: string;
        email?: string;
      };
    },
    [onCreateError]
  );

  const onConfirm = useCallback(
    async (event: StripeExpressCheckoutElementConfirmEvent) => {
      if (!stripe || !elements || submitting) {
        event.paymentFailed({ reason: 'fail' });
        return;
      }

      const payload = payloadRef.current;
      const analyticsService = analyticsServiceLabel(serviceTitleRef.current);

      onError(null);
      onSubmittingChange(true);
      trackBook(BOOKING_ANALYTICS_EVENTS.CHECKOUT_PAYMENT_ATTEMPT, {
        service: analyticsService,
        source: 'phone_booker_apple_pay',
      });

      try {
        const { error: submitError } = await elements.submit();
        if (submitError) {
          onError(friendlyStripeError(submitError));
          event.paymentFailed({ reason: 'fail' });
          return;
        }

        const hold = await createHold('phone_booker_apple_pay');
        const bookingName = hold.name || payload.name;
        const bookingEmail = hold.email || payload.email || '';

        const siRes = await fetchWithTimeout(
          '/api/stripe/create-setup-intent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              calBookingUid: hold.calBookingUid,
              ...(bookingName ? { name: bookingName } : {}),
              ...(bookingEmail ? { email: bookingEmail } : {}),
            }),
          },
          30_000
        );
        const siPayload = (await siRes.json().catch(() => null)) as {
          clientSecret?: string;
          message?: string;
          error?: string;
        } | null;
        if (!siRes.ok || !siPayload?.clientSecret) {
          throw new Error(
            siPayload?.message ||
              siPayload?.error ||
              'Could not start Apple Pay checkout.'
          );
        }

        const returnUrl = new URL('/book', window.location.origin);
        returnUrl.searchParams.set('uid', hold.calBookingUid);
        if (bookingName) returnUrl.searchParams.set('name', bookingName);
        if (bookingEmail) returnUrl.searchParams.set('email', bookingEmail);

        const { error, setupIntent } = await stripe.confirmSetup({
          elements,
          clientSecret: siPayload.clientSecret,
          confirmParams: { return_url: returnUrl.toString() },
          redirect: 'if_required',
        });

        if (error) {
          onError(friendlyStripeError(error));
          event.paymentFailed({ reason: 'fail' });
          return;
        }

        let finalIntent = setupIntent;
        if (finalIntent?.status === 'requires_action') {
          const next = await stripe.handleNextAction({
            clientSecret: siPayload.clientSecret,
          });
          if (next.error) {
            onError(friendlyStripeError(next.error));
            event.paymentFailed({ reason: 'fail' });
            return;
          }
          finalIntent = next.setupIntent ?? finalIntent;
        }

        if (!finalIntent || finalIntent.status !== 'succeeded') {
          onError(
            'Your card could not be confirmed. Please try again or pay with card.'
          );
          event.paymentFailed({ reason: 'fail' });
          return;
        }

        const confirmRes = await fetchWithTimeout(
          '/api/booking/confirm',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              setupIntentId: finalIntent.id,
              calBookingUid: hold.calBookingUid,
              ...(bookingName ? { name: bookingName } : {}),
              ...(bookingEmail ? { email: bookingEmail } : {}),
            }),
          },
          45_000
        );
        const confirmPayload = (await confirmRes.json().catch(() => null)) as {
          ok?: boolean;
          cal_accept_error?: string | null;
          contact?: { sms?: boolean; email?: boolean };
          message?: string;
          error?: string;
        } | null;

        if (!confirmRes.ok || confirmPayload?.ok === false) {
          throw new Error(
            confirmPayload?.message ||
              confirmPayload?.error ||
              'Card saved but appointment could not be confirmed.'
          );
        }

        trackBook(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
          service: analyticsService,
          source: 'phone_booker_apple_pay',
        });

        onConfirmed({
          name: bookingName,
          calWarning: confirmPayload?.cal_accept_error ?? null,
          contact: {
            sms: Boolean(confirmPayload?.contact?.sms),
            email: Boolean(confirmPayload?.contact?.email),
          },
        });
      } catch (err) {
        onError(
          err instanceof Error
            ? err.message
            : 'Something went wrong with Apple Pay. Try card instead.'
        );
        event.paymentFailed({ reason: 'fail' });
      } finally {
        onSubmittingChange(false);
      }
    },
    [
      stripe,
      elements,
      submitting,
      onError,
      onSubmittingChange,
      createHold,
      onConfirmed,
    ]
  );

  const showApplePay = expressReady && applePayAvailable;
  const waitingForWallet = prefersApplePay && !expressReady;
  const showWalletRow = showApplePay || waitingForWallet;

  return (
    <footer className={`${styles.footer} ${styles.footerStack}`}>
      <div className={styles.footerTotal}>
        <span className={styles.footerPrice}>{priceLabel || '$0'}</span>
        <span className={styles.footerHint}>
          {showWalletRow
            ? 'No charge today — Apple Pay saves your card'
            : 'Then secure checkout'}
        </span>
      </div>

      <div
        className={
          showWalletRow ? styles.footerActions : styles.footerActionsSolo
        }
      >
        {/*
          Keep one Express Checkout instance for the review step.
          Visible on the left when Apple Pay is available; otherwise parked
          off-screen until Stripe reports no wallet (then unmount).
        */}
        {(showWalletRow || !expressReady) && (
          <div
            className={
              showWalletRow ? styles.expressCheckout : styles.expressHostWarm
            }
            style={
              showWalletRow
                ? {
                    pointerEvents:
                      showApplePay && !submitting ? 'auto' : 'none',
                    opacity: submitting ? 0.5 : 1,
                  }
                : undefined
            }
            aria-hidden={!showWalletRow}
          >
            {waitingForWallet && !showApplePay ? (
              <div className={styles.applePaySlot} aria-hidden="true" />
            ) : null}
            <div
              className={
                showApplePay || !expressReady
                  ? styles.expressPainted
                  : styles.expressUnderSlot
              }
            >
              <ExpressCheckoutElement
                options={EXPRESS_OPTIONS}
                onReady={onReady}
                onClick={onClick}
                onConfirm={onConfirm}
                onLoadError={() => {
                  setExpressReady(true);
                  setApplePayAvailable(false);
                  onApplePayResolved?.(false);
                }}
                onCancel={() => onSubmittingChange(false)}
              />
            </div>
          </div>
        )}

        <button
          type="button"
          className={styles.primaryBtn}
          disabled={submitting}
          onClick={onPayWithCard}
        >
          {submitting
            ? 'Holding your time…'
            : showWalletRow
              ? 'Pay with card'
              : 'Continue to checkout'}
        </button>
      </div>
    </footer>
  );
}
