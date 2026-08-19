'use client';

/**
 * Express Checkout for /book pay step.
 * Parent owns footer chrome and dual-mounts setup + payment hosts so
 * switching pay-later / pay-now only toggles visibility (no remount).
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
import type { BookingPaymentTiming } from '@/lib/appointment-stripe';
import { prefersApplePayDevice } from '@/lib/prefers-apple-pay';

import styles from './book.module.css';

export { prefersApplePayDevice };

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
  return 'Apple Pay could not complete. Please try again or pay with card.';
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
  /** This host is the interactive Apple Pay button for the current choice. */
  active: boolean;
  paymentTiming: BookingPaymentTiming;
  serviceTitle: string;
  createPayload: Omit<BookCreatePayload, 'source'>;
  submitting: boolean;
  onSubmittingChange: (v: boolean) => void;
  onError: (message: string | null) => void;
  onCreateError: (data: { error?: string; message?: string }) => void;
  onConfirmed: (result: BookConfirmed) => void;
  onApplePayResolved: (available: boolean) => void;
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
  active,
  paymentTiming,
  serviceTitle,
  createPayload,
  submitting,
  onSubmittingChange,
  onError,
  onCreateError,
  onConfirmed,
  onApplePayResolved,
}: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const prefersApplePay = useMemo(() => prefersApplePayDevice(), []);
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [expressReady, setExpressReady] = useState(false);

  // Latest props mirrored into refs (after render, per react-hooks/refs) so
  // the Apple Pay onConfirm callback stays stable across re-renders.
  const payloadRef = useRef(createPayload);
  const serviceTitleRef = useRef(serviceTitle);
  const paymentTimingRef = useRef(paymentTiming);
  useEffect(() => {
    payloadRef.current = createPayload;
    serviceTitleRef.current = serviceTitle;
    paymentTimingRef.current = paymentTiming;
  }, [createPayload, serviceTitle, paymentTiming]);

  const onReady = useCallback(
    (event: StripeExpressCheckoutElementReadyEvent) => {
      const available = Boolean(event.availablePaymentMethods?.applePay);
      setExpressReady(true);
      setApplePayAvailable(available);
      onApplePayResolved(available);
    },
    [onApplePayResolved]
  );

  useEffect(() => {
    if (!prefersApplePay) onApplePayResolved(false);
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
        onCreateError(
          data ?? { message: 'Could not hold that time. Try again.' }
        );
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
      if (!stripe || !elements || submitting || !active) {
        event.paymentFailed({ reason: 'fail' });
        return;
      }

      const payload = payloadRef.current;
      const timing = paymentTimingRef.current;
      const analyticsService = analyticsServiceLabel(serviceTitleRef.current);

      onError(null);
      onSubmittingChange(true);
      trackBook(BOOKING_ANALYTICS_EVENTS.CHECKOUT_PAYMENT_ATTEMPT, {
        service: analyticsService,
        source: 'phone_booker_apple_pay',
        payment_timing: timing,
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

        const intentPath =
          timing === 'pay_now'
            ? '/api/stripe/create-booking-payment-intent'
            : '/api/stripe/create-setup-intent';
        const siRes = await fetchWithTimeout(
          intentPath,
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
        returnUrl.searchParams.set('payTiming', timing);
        if (bookingName) returnUrl.searchParams.set('name', bookingName);
        if (bookingEmail) returnUrl.searchParams.set('email', bookingEmail);

        let confirmId: string | null = null;
        if (timing === 'pay_now') {
          const { error, paymentIntent } = await stripe.confirmPayment({
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
          let finalPi = paymentIntent;
          if (finalPi?.status === 'requires_action') {
            const next = await stripe.handleNextAction({
              clientSecret: siPayload.clientSecret,
            });
            if (next.error) {
              onError(friendlyStripeError(next.error));
              event.paymentFailed({ reason: 'fail' });
              return;
            }
            finalPi = next.paymentIntent ?? finalPi;
          }
          if (!finalPi || finalPi.status !== 'succeeded') {
            onError(
              'Your payment could not be confirmed. Please try again or pay with card.'
            );
            event.paymentFailed({ reason: 'fail' });
            return;
          }
          confirmId = finalPi.id;
        } else {
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
          confirmId = finalIntent.id;
        }

        const confirmRes = await fetchWithTimeout(
          '/api/booking/confirm',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(timing === 'pay_now'
                ? { paymentIntentId: confirmId }
                : { setupIntentId: confirmId }),
              calBookingUid: hold.calBookingUid,
              ...(bookingName ? { name: bookingName } : {}),
              ...(bookingEmail ? { email: bookingEmail } : {}),
            }),
          },
          45_000
        );
        const confirmPayload = (await confirmRes.json().catch(() => null)) as {
          cal_accept_error?: string | null;
          contact?: { sms?: boolean; email?: boolean };
          message?: string;
          error?: string;
        } | null;
        if (!confirmRes.ok) {
          throw new Error(
            confirmPayload?.message ||
              confirmPayload?.error ||
              'Could not confirm your booking.'
          );
        }

        trackBook(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
          service: analyticsService,
          source: 'phone_booker_apple_pay',
          payment_timing: timing,
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
        const message =
          err instanceof Error
            ? err.message
            : 'Something went wrong with Apple Pay. Try card instead.';
        onError(message);
        event.paymentFailed({ reason: 'fail' });
      } finally {
        onSubmittingChange(false);
      }
    },
    [
      stripe,
      elements,
      submitting,
      active,
      onError,
      onSubmittingChange,
      createHold,
      onConfirmed,
    ]
  );

  const showApplePay = expressReady && applePayAvailable;
  const interactive = active && showApplePay && !submitting;

  return (
    <div
      className={styles.expressLayer}
      aria-hidden={!interactive}
      style={{
        pointerEvents: interactive ? 'auto' : 'none',
        // Keep inactive host mounted in-place (opacity 0) so radio switches
        // never remount Express Checkout.
        opacity: active ? (submitting ? 0.5 : 1) : 0,
        zIndex: active ? 1 : 0,
      }}
    >
      {active && prefersApplePay && !showApplePay ? (
        <div className={styles.applePaySlot} aria-hidden="true" />
      ) : null}
      <div
        className={
          active && prefersApplePay && !showApplePay
            ? styles.expressUnderSlot
            : styles.expressPainted
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
            onApplePayResolved(false);
          }}
          onCancel={() => onSubmittingChange(false)}
        />
      </div>
    </div>
  );
}
