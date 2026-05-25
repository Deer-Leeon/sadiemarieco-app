'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CHECKOUT_HOLD_MINUTES,
  formatCountdownMmSs,
  holdDeadlineMs,
  HOLD_EXPIRED_MESSAGE,
} from '@/lib/booking-hold';
import { loadStripe, type Stripe, type StripeElementsOptions } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';

// ──────────────────────────────────────────────────────────────────────────
// Stripe.js singleton
// ──────────────────────────────────────────────────────────────────────────
/**
 * `loadStripe` must be called exactly once per page load — calling it
 * inside the component would re-create the Stripe instance on every
 * render and tear-down/re-mount `<Elements>` (losing the user's card
 * input mid-flow). Resolved lazily so SSR doesn't try to ship Stripe.js
 * into the prerender output.
 *
 * Returns `null` when the publishable key isn't configured so the UI
 * can render a structured error instead of silently 500-ing on the
 * first card-collection attempt.
 */
const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
const stripePromise: Promise<Stripe | null> | null = STRIPE_PK
  ? loadStripe(STRIPE_PK)
  : null;

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
}

export default function CheckoutClient({
  initialHoldCreatedAt = null,
  initialHoldExpired = false,
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
  const email = params.get('email')?.trim() ?? '';

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [holdCreatedAt, setHoldCreatedAt] = useState<string | null>(
    initialHoldCreatedAt
  );
  const [holdExpired, setHoldExpired] = useState(initialHoldExpired);
  const [countdownLabel, setCountdownLabel] = useState('');

  // Poll the hold row so a cron-driven `canceled_by_system` flip disables
  // checkout even if the local timer hasn't ticked yet.
  useEffect(() => {
    if (!uid) return;

    let cancelled = false;

    const refreshHold = async () => {
      try {
        const res = await fetch(
          `/api/booking/hold?uid=${encodeURIComponent(uid)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as {
          createdAt?: string | null;
          expired?: boolean;
        };
        if (data.createdAt) setHoldCreatedAt(data.createdAt);
        if (data.expired) setHoldExpired(true);
      } catch {
        // Non-fatal — the local countdown still enforces the window.
      }
    };

    refreshHold();
    const pollId = window.setInterval(refreshHold, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(pollId);
    };
  }, [uid]);

  // 8-minute countdown from `appointments.created_at`.
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

  // Fetch a fresh SetupIntent client_secret on mount. We don't re-fetch
  // when the URL params change (they shouldn't — Cal lands once and
  // stays put) and we don't share intents across reloads since the
  // /api route is cheap and a stale secret can land in an "expired"
  // state on retry.
  useEffect(() => {
    if (holdExpired) return;

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
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/stripe/create-setup-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Empty body — the server doesn't require one. Sending an
          // explicit `{}` keeps the request well-formed for any
          // upstream proxy that's strict about Content-Length.
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string; message?: string }
            | null;
          throw new Error(
            payload?.message ??
              payload?.error ??
              `Could not initialise checkout (HTTP ${res.status})`
          );
        }
        const data = (await res.json()) as { clientSecret?: string };
        if (cancelled) return;
        if (!data.clientSecret) {
          throw new Error('Server returned no client secret');
        }
        setClientSecret(data.clientSecret);
      } catch (err) {
        if (cancelled) return;
        setBootstrapError(
          err instanceof Error
            ? err.message
            : 'Could not initialise checkout. Please try again.'
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, email, name, holdExpired]);

  const elementsOptions: StripeElementsOptions | null = useMemo(
    () =>
      clientSecret
        ? { clientSecret, appearance: STRIPE_APPEARANCE }
        : null,
    [clientSecret]
  );

  return (
    <main className="flex min-h-screen w-full flex-col items-center bg-[#FAF9F6] px-4 py-12 font-sans sm:py-16">
      <BrandHeader />

      <section className="mt-10 w-full max-w-md">
        {holdExpired ? (
          <ExpiredHoldCard />
        ) : bootstrapError ? (
          <ErrorCard message={bootstrapError} />
        ) : !elementsOptions || !stripePromise ? (
          <LoadingCard />
        ) : (
          <Elements stripe={stripePromise} options={elementsOptions}>
            <CheckoutForm
              uid={uid}
              name={name}
              email={email}
              holdExpired={holdExpired}
              countdownLabel={countdownLabel}
            />
          </Elements>
        )}
      </section>

      <Footnote />
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header / footer chrome
// ──────────────────────────────────────────────────────────────────────────
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
      Payments are processed securely by Stripe. Sadie Marie Beauty Studio
      never sees or stores your full card number.
    </p>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Form (inside Elements provider) — owns confirmSetup + /api/booking/confirm
// ──────────────────────────────────────────────────────────────────────────
interface FormProps {
  uid: string;
  name: string;
  email: string;
  holdExpired: boolean;
  countdownLabel: string;
}

function CheckoutForm({
  uid,
  name,
  email,
  holdExpired,
  countdownLabel,
}: FormProps) {
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    calWarning: string | null;
  } | null>(null);

  const ready = stripe !== null && elements !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (holdExpired || !stripe || !elements || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    // `redirect: 'if_required'` keeps the flow in-page for vanilla cards
    // and only navigates away when the issuer demands a 3DS challenge
    // page (rare on US cards, common on EU). When the challenge ends
    // Stripe brings the user back to the current URL with `?setup_intent=…`
    // appended; this page's URL already contains the booking context so
    // a future enhancement can read those query params to auto-resume.
    // For now the spec scope is "happy path no-redirect", which this
    // configuration delivers.
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });

    if (error) {
      setSubmitError(
        error.message ?? 'Could not save your card. Please try again.'
      );
      setSubmitting(false);
      return;
    }

    if (!setupIntent || setupIntent.status !== 'succeeded') {
      setSubmitError(
        'Your card could not be confirmed. Please check the details and try again.'
      );
      setSubmitting(false);
      return;
    }

    // Card vaulted on Stripe — hand off to our server to attach it to a
    // Customer, link to the appointments row, and accept the booking on
    // Cal.com. We swallow Cal failures here (the server returns them as
    // a non-blocking `cal_accept_error`) because the card is already
    // saved and the admin can confirm manually if needed.
    try {
      const res = await fetch('/api/booking/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupIntentId: setupIntent.id,
          // name + email are best-effort here — the server re-derives
          // them from the PaymentMethod's billing_details when these
          // aren't passed or aren't usable. Sending empty strings as
          // omitted keys keeps the request body small and lets the
          // server treat "absent" and "blank" identically.
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
          calBookingUid: uid,
        }),
      });

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
      };
      setConfirmed({ calWarning: data.cal_accept_error ?? null });
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Your card was saved but we could not finalise the appointment. Please contact the studio.'
      );
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return <SuccessCard name={name} calWarning={confirmed.calWarning} />;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm shadow-stone-900/[0.03] sm:p-10"
    >
      <h2 className="font-serif text-2xl text-stone-900">
        Secure your appointment
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">
        We&rsquo;ll save your card on file to confirm the booking.{' '}
        <span className="font-medium text-stone-700">
          No charge today.
        </span>
      </p>

      {countdownLabel && (
        <div
          className="mt-5 flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-4 py-3"
          aria-live="polite"
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
            Time remaining
          </p>
          <p className="font-mono text-lg font-medium tabular-nums text-stone-900">
            {countdownLabel}
          </p>
        </div>
      )}
      {countdownLabel && (
        <p className="mt-2 text-center text-[11px] text-stone-400">
          Complete checkout within {CHECKOUT_HOLD_MINUTES} minutes to hold
          your time slot.
        </p>
      )}

      {name && email && (
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
            Booking for
          </p>
          <p className="mt-1 text-sm font-medium text-stone-900">{name}</p>
          <p className="text-xs text-stone-500">{email}</p>
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
            <span>Saving your card&hellip;</span>
          </>
        ) : (
          <>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>Secure Appointment</span>
          </>
        )}
      </button>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-stone-400">
        Your card will only be charged for no-shows or late cancellations,
        per studio policy.
      </p>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// State cards
// ──────────────────────────────────────────────────────────────────────────
function LoadingCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-stone-200 bg-white p-10 text-center shadow-sm shadow-stone-900/[0.03]">
      <Loader2
        className="h-5 w-5 animate-spin text-stone-400"
        aria-hidden="true"
      />
      <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
        Preparing your secure checkout
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

function ExpiredHoldCard() {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center shadow-sm shadow-stone-900/[0.03] sm:p-10">
      <h2 className="font-serif text-2xl text-rose-900">
        Booking window closed
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-rose-800">
        {HOLD_EXPIRED_MESSAGE}
      </p>
      <Link
        href="/#services"
        className="mt-8 inline-flex w-full items-center justify-center rounded-md bg-stone-900 px-5 py-3 text-sm font-medium tracking-wide text-stone-50 transition-colors hover:bg-stone-800"
      >
        Return to booking calendar
      </Link>
    </div>
  );
}

function SuccessCard({
  name,
  calWarning,
}: {
  name: string;
  calWarning: string | null;
}) {
  // Be defensive about a missing `name` — the URL may not carry one
  // when Cal's `bookingSuccessful` payload didn't include attendees.
  const firstName = (name || '').trim().split(/\s+/)[0] || '';
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm shadow-stone-900/[0.03] sm:p-10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-stone-900 text-stone-50">
        <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
      </div>
      <h2 className="mt-6 font-serif text-3xl text-stone-900">
        {firstName ? `Thank you, ${firstName}.` : 'You\u2019re all set.'}
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-stone-600">
        Your appointment is confirmed. Check your email for the details
        and a link to manage your booking.
      </p>

      {calWarning && (
        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-left text-xs text-amber-900">
          <p className="font-medium">Heads up</p>
          <p className="mt-1 leading-relaxed">
            Your card is saved, but we couldn&rsquo;t finalise the calendar
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
