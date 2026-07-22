'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  checkoutHoldDurationLabel,
  formatCountdownMmSs,
  holdDeadlineMs,
  HOLD_EXPIRED_MESSAGE,
} from '@/lib/booking-hold';
import {
  formatAppointmentWhen,
  formatServiceTitleForDisplay,
} from '@/lib/format-booking-time';
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
/** Strip Stripe 3DS redirect params while keeping the Cal booking context. */
function clearStripeRedirectParams(uid: string, name: string, email: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('setup_intent');
  url.searchParams.delete('setup_intent_client_secret');
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
  setupIntentId: string;
  calBookingUid: string;
  name: string;
  email: string;
}): Promise<{ calWarning: string | null }> {
  const res = await fetch('/api/booking/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      setupIntentId: params.setupIntentId,
      calBookingUid: params.calBookingUid,
      ...(params.name ? { name: params.name } : {}),
      ...(params.email ? { email: params.email } : {}),
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
  return { calWarning: data.cal_accept_error ?? null };
}

function readThreeDsSetupIntentId(
  params: ReturnType<typeof useSearchParams>
): string | null {
  if (params.get('redirect_status') !== 'succeeded') return null;
  const id = params.get('setup_intent')?.trim() ?? '';
  return id.startsWith('seti_') ? id : null;
}

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
}

export default function CheckoutClient({
  initialHoldCreatedAt = null,
  initialHoldExpired = false,
  initialBookingTime = null,
  initialEndTime = null,
  initialServiceName = null,
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
  const threeDsSetupIntentId = useMemo(
    () => readThreeDsSetupIntentId(params),
    [params]
  );

  const [clientSecret, setClientSecret] = useState<string | null>(null);
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
  /** Gate the return CTA until Cal cancel finishes — otherwise the booker can reopen while the only Saturday slot is still held. */
  const [holdReleaseState, setHoldReleaseState] = useState<
    'idle' | 'releasing' | 'released' | 'failed'
  >('idle');

  const appointmentWhen = useMemo(
    () => (bookingTime ? formatAppointmentWhen(bookingTime, endTime) : null),
    [bookingTime, endTime]
  );
  const serviceLabel = useMemo(
    () => formatServiceTitleForDisplay(serviceName),
    [serviceName]
  );

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
          bookingTime?: string | null;
          endTime?: string | null;
          serviceName?: string | null;
        };
        if (data.createdAt) setHoldCreatedAt(data.createdAt);
        if (data.expired) setHoldExpired(true);
        if (data.bookingTime) setBookingTime(data.bookingTime);
        if (data.endTime !== undefined) setEndTime(data.endTime ?? null);
        if (data.serviceName) setServiceName(data.serviceName);
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

  // Fetch a fresh SetupIntent client_secret on mount. We don't re-fetch
  // when the URL params change (they shouldn't — Cal lands once and
  // stays put) and we don't share intents across reloads since the
  // /api route is cheap and a stale secret can land in an "expired"
  // state on retry.
  useEffect(() => {
    // Returning from a 3DS challenge — the URL carries the succeeded
    // SetupIntent id; CheckoutThreeDSResume finalises without minting
    // a fresh intent (which would orphan the authenticated vault).
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
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/stripe/create-setup-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calBookingUid: uid,
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
          }),
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
  }, [uid, email, name, holdExpired, threeDsSetupIntentId]);

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
          <ExpiredHoldCard releaseState={holdReleaseState} />
        ) : threeDsSetupIntentId ? (
          <CheckoutThreeDSResume
            uid={uid}
            name={name}
            email={email}
            setupIntentId={threeDsSetupIntentId}
          />
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
              appointmentWhen={appointmentWhen}
              serviceLabel={serviceLabel}
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
}: {
  uid: string;
  name: string;
  email: string;
  setupIntentId: string;
}) {
  const [submitting, setSubmitting] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    calWarning: string | null;
  } | null>(null);
  const resumeStartedRef = useRef(false);

  useEffect(() => {
    if (!uid || resumeStartedRef.current) return;
    resumeStartedRef.current = true;

    (async () => {
      try {
        const result = await callBookingConfirm({
          setupIntentId,
          calBookingUid: uid,
          name,
          email,
        });
        clearStripeRedirectParams(uid, name, email);
        setConfirmed({ calWarning: result.calWarning });
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : 'Your card was saved but we could not finalise the appointment. Please contact the studio.'
        );
      } finally {
        setSubmitting(false);
      }
    })();
  }, [uid, name, email, setupIntentId]);

  if (confirmed) {
    return <SuccessCard name={name} calWarning={confirmed.calWarning} />;
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
  countdownLabel: string;
  appointmentWhen: { date: string; timeRange: string } | null;
  serviceLabel: string;
}

function CheckoutForm({
  uid,
  name,
  email,
  holdExpired,
  countdownLabel,
  appointmentWhen,
  serviceLabel,
}: FormProps) {
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    calWarning: string | null;
  } | null>(null);

  const ready = stripe !== null && elements !== null;
  const searchParams = useSearchParams();
  const resumeStartedRef = useRef(false);

  const finalizeBooking = useCallback(
    async (setupIntentId: string) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await callBookingConfirm({
          setupIntentId,
          calBookingUid: uid,
          name,
          email,
        });
        clearStripeRedirectParams(uid, name, email);
        setConfirmed({ calWarning: result.calWarning });
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : 'Your card was saved but we could not finalise the appointment. Please contact the studio.'
        );
        setSubmitting(false);
      }
    },
    [uid, name, email]
  );

  // In-page 3DS return (rare) or bookmarked return URL — same auto-finalise
  // path as the full-page redirect handled by CheckoutThreeDSResume.
  useEffect(() => {
    if (holdExpired || !uid || resumeStartedRef.current || confirmed) {
      return;
    }
    const redirectStatus = searchParams.get('redirect_status');
    const setupIntentId = searchParams.get('setup_intent')?.trim() ?? '';
    if (redirectStatus !== 'succeeded' || !setupIntentId.startsWith('seti_')) {
      return;
    }
    resumeStartedRef.current = true;
    void finalizeBooking(setupIntentId);
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

    setSubmitting(true);
    setSubmitError(null);

    const returnUrl = new URL('/checkout', window.location.origin);
    returnUrl.searchParams.set('uid', uid);
    if (name) returnUrl.searchParams.set('name', name);
    if (email) returnUrl.searchParams.set('email', email);

    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: returnUrl.toString(),
      },
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

    await finalizeBooking(setupIntent.id);
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
        We&rsquo;ll save your card on file to confirm the booking.
        <span className="mt-1 block font-medium text-stone-700">
          No charge today.
        </span>
      </p>

      {appointmentWhen && (
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
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
          Complete checkout within {checkoutHoldDurationLabel()} to hold
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
