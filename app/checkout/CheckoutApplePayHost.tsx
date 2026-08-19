'use client';

/**
 * Express Checkout (Apple Pay) for desktop /checkout.
 * The booking hold already exists (Cal uid in the URL) — unlike /book,
 * this host does not create a new hold. Parent dual-mounts setup +
 * payment Elements so pay-later / pay-now switches stay smooth.
 *
 * Apple Pay is only offered when the browser reports it (typically
 * Safari/Chrome on a Mac with a card in Wallet). Windows has no
 * ApplePaySession, so the parent never mounts this host there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@vercel/analytics';
import {
  ExpressCheckoutElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import type {
  StripeExpressCheckoutElementClickEvent,
  StripeExpressCheckoutElementConfirmEvent,
  StripeExpressCheckoutElementOptions,
  StripeExpressCheckoutElementReadyEvent,
} from '@stripe/stripe-js';

import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
} from '@/lib/booking-analytics';
import type { BookingPaymentTiming } from '@/lib/appointment-stripe';
import { prefersApplePayDevice } from '@/lib/prefers-apple-pay';

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

export type CheckoutApplePayConfirmed = {
  name: string;
  calWarning: string | null;
  contact: { sms: boolean; email: boolean };
};

type Props = {
  active: boolean;
  paymentTiming: BookingPaymentTiming;
  uid: string;
  name: string;
  email: string;
  serviceTitle: string;
  submitting: boolean;
  onSubmittingChange: (v: boolean) => void;
  onError: (message: string | null) => void;
  onConfirmed: (result: CheckoutApplePayConfirmed) => void;
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

export default function CheckoutApplePayHost({
  active,
  paymentTiming,
  uid,
  name,
  email,
  serviceTitle,
  submitting,
  onSubmittingChange,
  onError,
  onConfirmed,
  onApplePayResolved,
}: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const prefersApplePay = useMemo(() => prefersApplePayDevice(), []);
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [expressReady, setExpressReady] = useState(false);

  const uidRef = useRef(uid);
  uidRef.current = uid;
  const nameRef = useRef(name);
  nameRef.current = name;
  const emailRef = useRef(email);
  emailRef.current = email;
  const serviceTitleRef = useRef(serviceTitle);
  serviceTitleRef.current = serviceTitle;
  const paymentTimingRef = useRef(paymentTiming);
  paymentTimingRef.current = paymentTiming;

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

  const onConfirm = useCallback(
    async (event: StripeExpressCheckoutElementConfirmEvent) => {
      if (!stripe || !elements || submitting || !active) {
        event.paymentFailed({ reason: 'fail' });
        return;
      }

      const timing = paymentTimingRef.current;
      const calBookingUid = uidRef.current;
      const bookingName = nameRef.current;
      const bookingEmail = emailRef.current;
      const analyticsService = analyticsServiceLabel(serviceTitleRef.current);

      onError(null);
      onSubmittingChange(true);
      try {
        track(BOOKING_ANALYTICS_EVENTS.CHECKOUT_PAYMENT_ATTEMPT, {
          service: analyticsService,
          source: 'checkout_apple_pay',
          payment_timing: timing,
        });
      } catch {
        /* analytics must never break checkout */
      }

      try {
        const { error: submitError } = await elements.submit();
        if (submitError) {
          onError(friendlyStripeError(submitError));
          event.paymentFailed({ reason: 'fail' });
          return;
        }

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
              calBookingUid,
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

        const returnUrl = new URL('/checkout', window.location.origin);
        returnUrl.searchParams.set('uid', calBookingUid);
        if (timing === 'pay_now') returnUrl.searchParams.set('payMode', 'now');
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
              calBookingUid,
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

        try {
          track(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
            service: analyticsService,
            source: 'checkout_apple_pay',
            payment_timing: timing,
          });
        } catch {
          /* ignore */
        }
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
    [stripe, elements, submitting, active, onError, onSubmittingChange, onConfirmed]
  );

  const showApplePay = expressReady && applePayAvailable;
  const interactive = active && showApplePay && !submitting;

  return (
    <div
      className="absolute inset-0 w-full"
      aria-hidden={!interactive}
      style={{
        pointerEvents: interactive ? 'auto' : 'none',
        opacity: active ? (submitting ? 0.5 : 1) : 0,
        zIndex: active ? 1 : 0,
      }}
    >
      {active && prefersApplePay && !showApplePay ? (
        <div className="h-12 w-full rounded bg-black" aria-hidden="true" />
      ) : null}
      <div
        className={
          active && prefersApplePay && !showApplePay
            ? 'absolute inset-0 opacity-0'
            : 'relative'
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
