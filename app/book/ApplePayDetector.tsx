'use client';

/**
 * Hidden Express Checkout mount so Apple Pay availability is known
 * before the review footer paints (avoids Continue → Apple Pay flash).
 */

import { useEffect } from 'react';
import { ExpressCheckoutElement } from '@stripe/react-stripe-js';
import type {
  StripeExpressCheckoutElementOptions,
  StripeExpressCheckoutElementReadyEvent,
} from '@stripe/stripe-js';

const DETECT_OPTIONS: StripeExpressCheckoutElementOptions = {
  buttonHeight: 48,
  paymentMethods: {
    applePay: 'auto',
    googlePay: 'never',
    link: 'never',
    paypal: 'never',
    amazonPay: 'never',
    klarna: 'never',
  },
  business: { name: 'Sadie Marie' },
};

export function prefersApplePayDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const AP = (
      window as Window & {
        ApplePaySession?: {
          canMakePayments?: () => boolean;
        };
      }
    ).ApplePaySession;
    if (!AP || typeof AP.canMakePayments !== 'function') return false;
    return AP.canMakePayments();
  } catch {
    return false;
  }
}

export default function ApplePayDetector({
  onResult,
}: {
  onResult: (available: boolean) => void;
}) {
  useEffect(() => {
    // If the device clearly can't do Apple Pay, don't wait on Stripe.
    if (!prefersApplePayDevice()) {
      onResult(false);
    }
  }, [onResult]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: -9999,
        top: 0,
        width: 320,
        height: 48,
        overflow: 'hidden',
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      <ExpressCheckoutElement
        options={DETECT_OPTIONS}
        onReady={(event: StripeExpressCheckoutElementReadyEvent) => {
          onResult(Boolean(event.availablePaymentMethods?.applePay));
        }}
        onLoadError={() => onResult(false)}
        onConfirm={() => {
          /* detect-only mount */
        }}
      />
    </div>
  );
}
