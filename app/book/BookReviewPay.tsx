'use client';

import { useCallback, useMemo, useState } from 'react';
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

function friendlyStripeError(error: {
  message?: string;
  code?: string;
}): string {
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
  /** Kept for API symmetry / future MIT options; unused in setup-mode vault. */
  servicePriceCents: number;
  selectedStart: string;
  createPayload: Omit<BookCreatePayload, 'source'>;
  submitting: boolean;
  onSubmittingChange: (v: boolean) => void;
  onError: (message: string | null) => void;
  onCreateError: (data: {
    error?: string;
    message?: string;
  }) => void;
  onPayWithCard: () => void;
  onConfirmed: (result: BookConfirmed) => void;
};

/**
 * Review-step payment footer: Apple Pay (Express Checkout) when available,
 * otherwise Continue to checkout / Pay with card.
 *
 * SetupIntent vault only — do not attach Apple Pay deferred/recurring
 * merchant-token options here; those assume a payment amount and have
 * crashed the review step in Safari/Chrome when free-cancel dates are
 * in the past or amount is 0.
 */
export default function BookReviewPay({
  priceLabel,
  serviceTitle,
  createPayload,
  submitting,
  onSubmittingChange,
  onError,
  onCreateError,
  onPayWithCard,
  onConfirmed,
}: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [expressReady, setExpressReady] = useState(false);

  const analyticsService = analyticsServiceLabel(serviceTitle);

  const expressOptions: StripeExpressCheckoutElementOptions = useMemo(
    () => ({
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
    }),
    []
  );

  const onReady = useCallback((event: StripeExpressCheckoutElementReadyEvent) => {
    setExpressReady(true);
    setApplePayAvailable(Boolean(event.availablePaymentMethods?.applePay));
  }, []);

  const onClick = useCallback(
    (event: StripeExpressCheckoutElementClickEvent) => {
      // Resolve promptly — required within ~1s of the click event.
      event.resolve({});
    },
    []
  );

  const createHold = useCallback(
    async (source: BookCreatePayload['source']) => {
      const res = await fetchWithTimeout(
        '/api/book/create',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...createPayload, source }),
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
    [createPayload, onCreateError]
  );

  const onConfirm = useCallback(
    async (event: StripeExpressCheckoutElementConfirmEvent) => {
      if (!stripe || !elements || submitting) {
        event.paymentFailed({ reason: 'fail' });
        return;
      }

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
        const bookingName = hold.name || createPayload.name;
        const bookingEmail = hold.email || createPayload.email || '';

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
          confirmParams: {
            return_url: returnUrl.toString(),
          },
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
      onError,
      onSubmittingChange,
      analyticsService,
      createHold,
      createPayload.name,
      createPayload.email,
      onConfirmed,
    ]
  );

  const showApplePay = expressReady && applePayAvailable;

  return (
    <footer className={`${styles.footer} ${styles.footerStack}`}>
      <div className={styles.footerTotal}>
        <span className={styles.footerPrice}>{priceLabel}</span>
        <span className={styles.footerHint}>
          {showApplePay
            ? 'No charge today — Apple Pay saves your card'
            : 'Then secure checkout'}
        </span>
      </div>

      <div
        className={styles.expressCheckout}
        style={{
          visibility: showApplePay ? 'visible' : 'hidden',
          minHeight: showApplePay || !expressReady ? 48 : 0,
          height: showApplePay || !expressReady ? undefined : 0,
          overflow: 'hidden',
          pointerEvents: showApplePay && !submitting ? 'auto' : 'none',
          opacity: submitting ? 0.5 : 1,
        }}
      >
        <ExpressCheckoutElement
          options={expressOptions}
          onReady={onReady}
          onClick={onClick}
          onConfirm={onConfirm}
          onLoadError={() => {
            setExpressReady(true);
            setApplePayAvailable(false);
          }}
          onCancel={() => onSubmittingChange(false)}
        />
      </div>

      {showApplePay ? (
        <button
          type="button"
          className={styles.textLinkBtn}
          disabled={submitting}
          onClick={onPayWithCard}
        >
          Pay with card instead
        </button>
      ) : (
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={submitting}
          onClick={onPayWithCard}
        >
          {submitting ? 'Holding your time…' : 'Continue to checkout'}
        </button>
      )}
    </footer>
  );
}
