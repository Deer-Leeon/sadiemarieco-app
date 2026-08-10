'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { track } from '@vercel/analytics';
import { Elements } from '@stripe/react-stripe-js';
import type { StripeElementsOptions } from '@stripe/stripe-js';

import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
} from '@/lib/booking-analytics';
import { BOOK_PHONE_MAX_WIDTH_PX } from '@/lib/book-public';
import { STUDIO_SMS_CONSENT_LABEL } from '@/lib/cal-event-studio-defaults';
import { formatAppointmentWhen } from '@/lib/format-booking-time';
import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { stripePromise } from '@/lib/stripe-browser';

import BookPayErrorBoundary from './BookPayErrorBoundary';
import ApplePayDetector, { prefersApplePayDevice } from './ApplePayDetector';
import BookReviewPay, { type BookConfirmed } from './BookReviewPay';
import styles from './book.module.css';

type Step = 'service' | 'when' | 'contact' | 'review';

interface BookService {
  slug: string;
  title: string;
  category: string;
  description: string | null;
  priceLabel: string;
  priceCents: number;
  durationMins: number;
  durationLabel: string;
}

function trackBook(name: string, data?: Record<string, string | number | boolean | null>) {
  try {
    track(name, data);
  } catch {
    /* ignore */
  }
}

function studioTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatDayChip(ymd: string): { weekday: string; monthDay: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'short',
  }).format(dt);
  const monthDay = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    month: 'short',
    day: 'numeric',
  }).format(dt);
  return { weekday, monthDay };
}

function formatSlotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function isPhoneViewport(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia(`(max-width: ${BOOK_PHONE_MAX_WIDTH_PX}px)`).matches;
}

const STEPS: Step[] = ['service', 'when', 'contact', 'review'];

export default function BookClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const presetSlug = searchParams.get('service')?.trim() ?? '';

  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step>('service');
  const [services, setServices] = useState<BookService[]>([]);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BookService | null>(null);

  const [dayOptions, setDayOptions] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>('');
  const [slotsByDay, setSlotsByDay] = useState<Record<string, string[]>>({});
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [email, setEmail] = useState('');
  const [showReachPanel, setShowReachPanel] = useState(false);
  const [showEmailInReach, setShowEmailInReach] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [reachError, setReachError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<BookConfirmed | null>(null);
  const [applePayPrefetch, setApplePayPrefetch] = useState<boolean | null>(
    null
  );
  const [prefersApplePay, setPrefersApplePay] = useState(false);

  const onApplePayPrefetch = useCallback((available: boolean) => {
    setApplePayPrefetch(available);
  }, []);

  const elementsOptions: StripeElementsOptions = useMemo(
    () => ({
      mode: 'setup',
      currency: 'usd',
      appearance: {
        theme: 'flat',
        variables: {
          colorPrimary: '#0d1b2a',
          borderRadius: '0px',
        },
      },
    }),
    []
  );

  useEffect(() => {
    if (!isPhoneViewport()) {
      window.location.replace('/#services');
      return;
    }
    setReady(true);
    setPrefersApplePay(prefersApplePayDevice());
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/book/services', {
          headers: { Accept: 'application/json' },
        });
        const data = (await res.json().catch(() => null)) as {
          services?: BookService[];
          message?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok) {
          setServicesError(data?.message || 'Could not load services.');
          return;
        }
        const list = (data?.services ?? []).map((s) => ({
          ...s,
          priceCents:
            typeof s.priceCents === 'number' && Number.isFinite(s.priceCents)
              ? s.priceCents
              : 0,
        }));
        setServices(list);
        if (presetSlug) {
          const match = list.find((s) => s.slug === presetSlug);
          if (match) {
            setSelected(match);
            setStep('when');
            trackBook(BOOKING_ANALYTICS_EVENTS.SERVICE_OPENED, {
              service: analyticsServiceLabel(match.title),
              source: 'phone_booker',
            });
          }
        }
      } catch {
        if (!cancelled) setServicesError('Could not load services.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, presetSlug]);

  const loadSlots = useCallback(async (slug: string) => {
    setSlotsLoading(true);
    setSlotsError(null);
    const start = studioTodayYmd();
    const end = addDaysYmd(start, 20);
    const days: string[] = [];
    for (let i = 0; i <= 20; i += 1) days.push(addDaysYmd(start, i));
    setDayOptions(days);
    setSelectedDay(start);
    setSelectedStart(null);

    try {
      const params = new URLSearchParams({
        slug,
        date: start,
        end,
      });
      const res = await fetch(`/api/book/slots?${params}`, {
        headers: { Accept: 'application/json' },
      });
      const data = (await res.json().catch(() => null)) as {
        slots?: Record<string, string[]>;
        message?: string;
      } | null;
      if (!res.ok) {
        setSlotsByDay({});
        setSlotsError(data?.message || 'Could not load times.');
        return;
      }
      setSlotsByDay(data?.slots ?? {});
      const firstWithSlots = days.find((d) => (data?.slots?.[d]?.length ?? 0) > 0);
      if (firstWithSlots) setSelectedDay(firstWithSlots);
    } catch {
      setSlotsError('Could not load times.');
      setSlotsByDay({});
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === 'when' && selected?.slug) {
      void loadSlots(selected.slug);
    }
  }, [step, selected?.slug, loadSlots]);

  const daySlots = useMemo(
    () => (selectedDay ? slotsByDay[selectedDay] ?? [] : []),
    [selectedDay, slotsByDay]
  );

  const appointmentWhen = useMemo(() => {
    if (!selectedStart) return null;
    return formatAppointmentWhen(selectedStart, null);
  }, [selectedStart]);

  const servicesByCategory = useMemo(() => {
    const map = new Map<string, BookService[]>();
    for (const s of services) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return map;
  }, [services]);

  const fullName = useMemo(
    () => [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
    [firstName, lastName]
  );

  // Rare Apple Pay / wallet 3DS redirect return onto /book.
  useEffect(() => {
    if (!ready || confirmed) return;
    const redirectStatus = searchParams.get('redirect_status');
    const setupIntentId = searchParams.get('setup_intent')?.trim() ?? '';
    const uid = searchParams.get('uid')?.trim() ?? '';
    const resumeName = searchParams.get('name')?.trim() ?? '';
    const resumeEmail = searchParams.get('email')?.trim() ?? '';
    if (
      redirectStatus !== 'succeeded' ||
      !setupIntentId.startsWith('seti_') ||
      !uid
    ) {
      return;
    }

    let cancelled = false;
    (async () => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await fetch('/api/booking/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setupIntentId,
            calBookingUid: uid,
            ...(resumeName ? { name: resumeName } : {}),
            ...(resumeEmail ? { email: resumeEmail } : {}),
          }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          cal_accept_error?: string | null;
          contact?: { sms?: boolean; email?: boolean };
          message?: string;
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || data?.ok === false) {
          setSubmitError(
            data?.message ||
              data?.error ||
              'Your card was saved but we could not confirm the appointment.'
          );
          return;
        }
        trackBook(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
          source: 'phone_booker_apple_pay',
        });
        setConfirmed({
          name: resumeName || fullName,
          calWarning: data?.cal_accept_error ?? null,
          contact: {
            sms: Boolean(data?.contact?.sms),
            email: Boolean(data?.contact?.email),
          },
        });
        const url = new URL(window.location.href);
        url.searchParams.delete('setup_intent');
        url.searchParams.delete('setup_intent_client_secret');
        url.searchParams.delete('redirect_status');
        const qs = url.searchParams.toString();
        window.history.replaceState(
          {},
          '',
          qs ? `${url.pathname}?${qs}` : url.pathname
        );
      } catch {
        if (!cancelled) {
          setSubmitError(
            'Your card was saved but we could not confirm the appointment.'
          );
        }
      } finally {
        if (!cancelled) setSubmitting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, confirmed, searchParams, fullName]);

  const stepIndex = STEPS.indexOf(step);

  const goBack = () => {
    if (showReachPanel) {
      setShowReachPanel(false);
      setShowEmailInReach(false);
      setReachError(null);
      return;
    }
    if (step === 'service') {
      router.push('/#services');
      return;
    }
    const prev = STEPS[Math.max(0, stepIndex - 1)];
    setStep(prev);
    setSubmitError(null);
    setContactError(null);
  };

  const pickService = (service: BookService) => {
    setSelected(service);
    setSelectedStart(null);
    trackBook(BOOKING_ANALYTICS_EVENTS.SERVICE_OPENED, {
      service: analyticsServiceLabel(service.title),
      source: 'phone_booker',
    });
    setStep('when');
  };

  const continueFromWhen = () => {
    if (!selectedStart) return;
    setStep('contact');
  };

  const continueFromContact = () => {
    setContactError(null);
    setReachError(null);
    if (!firstName.trim()) {
      setContactError('Enter your first name.');
      return;
    }
    if (!lastName.trim()) {
      setContactError('Enter your last name.');
      return;
    }
    if (!phone.trim()) {
      setContactError('Enter your phone number.');
      return;
    }
    if (smsOptIn || email.trim()) {
      setShowReachPanel(false);
      setStep('review');
      return;
    }
    // Match desktop: ask again to opt into texts before revealing email.
    setShowReachPanel(true);
    setShowEmailInReach(false);
  };

  const continueFromReachPanel = () => {
    setReachError(null);
    if (smsOptIn) {
      setShowReachPanel(false);
      setStep('review');
      return;
    }
    if (showEmailInReach && email.trim()) {
      setShowReachPanel(false);
      setStep('review');
      return;
    }
    if (!showEmailInReach) {
      setReachError('Check the box so we can text appointment updates.');
      return;
    }
    setReachError('Add an email so we can reach you about your booking.');
  };

  const submitBooking = async () => {
    if (!selected || !selectedStart || submitting || confirmed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/book/create', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: selected.slug,
          start: selectedStart,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          name: fullName,
          phone: phone.trim(),
          email: email.trim() || undefined,
          smsOptIn,
          source: 'phone_booker',
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        calBookingUid?: string;
        name?: string;
        email?: string;
        error?: string;
        message?: string;
      } | null;

      if (!res.ok || !data?.calBookingUid) {
        handleCreateError(data);
        return;
      }

      const params = new URLSearchParams({ uid: data.calBookingUid });
      if (data.name) params.set('name', data.name);
      if (data.email) params.set('email', data.email);
      window.location.assign(`/checkout?${params.toString()}`);
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateError = (data: {
    error?: string;
    message?: string;
  } | null) => {
    if (data?.error === 'phone_not_sms_capable') {
      setSmsOptIn(false);
      setStep('contact');
      setShowReachPanel(true);
      setShowEmailInReach(true);
      setReachError(
        data.message ||
          'That number may not receive texts. Add an email instead.'
      );
      return;
    }
    if (data?.error === 'contact_required') {
      setStep('contact');
      setShowReachPanel(true);
      setShowEmailInReach(false);
      setReachError(data.message || 'Add email or text opt-in.');
      return;
    }
    setSubmitError(data?.message || 'Could not hold that time. Try again.');
  };

  const createPayload = useMemo(
    () => ({
      slug: selected?.slug ?? '',
      start: selectedStart ?? '',
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      name: fullName,
      phone: phone.trim(),
      email: email.trim() || undefined,
      smsOptIn,
    }),
    [
      selected?.slug,
      selectedStart,
      firstName,
      lastName,
      fullName,
      phone,
      email,
      smsOptIn,
    ]
  );

  if (!ready) {
    return (
      <div className={styles.shell}>
        <p className={styles.loading}>Opening booking…</p>
      </div>
    );
  }

  const stepTitle =
    confirmed
      ? "You're booked"
      : step === 'service'
        ? 'Select a service'
        : step === 'when'
          ? 'Pick a time'
          : step === 'contact'
            ? 'Your details'
            : 'Review and continue';

  if (confirmed) {
    const first = (confirmed.name || '').trim().split(/\s+/)[0] || '';
    const channel =
      confirmed.contact.sms && confirmed.contact.email
        ? 'texts and email'
        : confirmed.contact.sms
          ? 'texts'
          : confirmed.contact.email
            ? 'email'
            : 'messages';
    return (
      <div className={styles.shell}>
        <header className={styles.topBar}>
          <span className={styles.iconBtn} aria-hidden="true" />
          <p className={styles.brand}>Sadie Marie</p>
          <Link href="/" className={styles.iconBtn} aria-label="Home">
            ✕
          </Link>
        </header>
        <main className={styles.main}>
          <div className={styles.successCard}>
            <h1 className={styles.successTitle}>
              {first ? `Thank you, ${first}.` : "You're all set."}
            </h1>
            <p className={styles.successBody}>
              Your appointment is confirmed. Check your {channel} for the
              details and a link to manage your booking.
            </p>
            {confirmed.calWarning ? (
              <div className={styles.successWarn}>
                Your card is saved, but we couldn&apos;t finalise the calendar
                invite automatically. The studio will confirm with you shortly.
              </div>
            ) : null}
            <Link href="/" className={styles.primaryBtn} style={{ marginTop: 24, display: 'inline-block' }}>
              Back to home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        {step === 'service' ? (
          <span className={styles.iconBtn} aria-hidden="true" />
        ) : (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={goBack}
            aria-label="Back"
          >
            ←
          </button>
        )}
        <p className={styles.brand}>Sadie Marie</p>
        <Link href="/" className={styles.iconBtn} aria-label="Home">
          ✕
        </Link>
      </header>

      <div className={styles.progress} aria-hidden="true">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`${styles.progressDot} ${i <= stepIndex ? styles.progressDotOn : ''}`}
          />
        ))}
      </div>

      <main
        className={`${styles.main} ${step === 'review' ? styles.mainReview : ''}`}
      >
        <h1
          className={`${styles.title} ${step === 'review' ? styles.titleReview : ''}`}
        >
          {stepTitle}
        </h1>

        {step === 'service' && (
          <section className={styles.section}>
            {servicesError && <p className={styles.error}>{servicesError}</p>}
            {!servicesError && services.length === 0 && (
              <p className={styles.muted}>Loading services…</p>
            )}
            {[...servicesByCategory.entries()].map(([category, list]) => (
              <div key={category} className={styles.categoryBlock}>
                <p className={styles.categoryLabel}>{category}</p>
                <ul className={styles.serviceList}>
                  {list.map((service) => (
                    <li key={service.slug}>
                      <button
                        type="button"
                        className={styles.serviceRow}
                        onClick={() => pickService(service)}
                      >
                        <span className={styles.serviceMain}>
                          <span className={styles.serviceName}>
                            {service.title}
                          </span>
                          {service.description ? (
                            <span className={styles.serviceDesc}>
                              {service.description}
                            </span>
                          ) : null}
                        </span>
                        <span className={styles.serviceMeta}>
                          <span className={styles.servicePrice}>
                            {service.priceLabel}
                          </span>
                          <span className={styles.serviceDuration}>
                            {service.durationLabel}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {step === 'when' && selected && (
          <section className={styles.section}>
            <p className={styles.selectedService}>
              {selected.title} · {selected.priceLabel} · {selected.durationLabel}
            </p>
            {slotsLoading && <p className={styles.muted}>Loading times…</p>}
            {slotsError && <p className={styles.error}>{slotsError}</p>}
            {!slotsLoading && !slotsError && (
              <>
                <div className={styles.dayScroller}>
                  {dayOptions.map((ymd) => {
                    const chip = formatDayChip(ymd);
                    const count = slotsByDay[ymd]?.length ?? 0;
                    const active = ymd === selectedDay;
                    return (
                      <button
                        key={ymd}
                        type="button"
                        disabled={count === 0}
                        className={`${styles.dayChip} ${active ? styles.dayChipOn : ''}`}
                        onClick={() => {
                          setSelectedDay(ymd);
                          setSelectedStart(null);
                        }}
                      >
                        <span>{chip.weekday}</span>
                        <span>{chip.monthDay}</span>
                      </button>
                    );
                  })}
                </div>
                <div className={styles.slotGrid}>
                  {daySlots.length === 0 ? (
                    <p className={styles.muted}>No openings this day.</p>
                  ) : (
                    daySlots.map((iso) => (
                      <button
                        key={iso}
                        type="button"
                        className={`${styles.slotChip} ${selectedStart === iso ? styles.slotChipOn : ''}`}
                        onClick={() => setSelectedStart(iso)}
                      >
                        {formatSlotTime(iso)}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {step === 'contact' && (
          <section className={styles.section}>
            <div className={styles.nameRow}>
              <label className={styles.field}>
                <span>
                  First name <abbr className={styles.req} title="required">*</abbr>
                </span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  placeholder="First name"
                  required
                />
              </label>
              <label className={styles.field}>
                <span>
                  Last name <abbr className={styles.req} title="required">*</abbr>
                </span>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  placeholder="Last name"
                  required
                />
              </label>
            </div>
            <label className={styles.field}>
              <span>
                Phone number <abbr className={styles.req} title="required">*</abbr>
              </span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                inputMode="tel"
                placeholder="+1 555 123 4567"
                required
              />
            </label>
            <label className={styles.smsLabel}>
              <input
                type="checkbox"
                checked={smsOptIn}
                onChange={(e) => {
                  setSmsOptIn(e.target.checked);
                  setContactError(null);
                }}
              />
              <span>{STUDIO_SMS_CONSENT_LABEL}</span>
            </label>
            {contactError && <p className={styles.error}>{contactError}</p>}
          </section>
        )}

        {step === 'review' && selected && selectedStart && (
          <section className={`${styles.section} ${styles.reviewSection}`}>
            <div className={styles.reviewSheet}>
              <div className={styles.reviewBlock}>
                <p className={styles.reviewEyebrow}>Your appointment</p>
                <p className={styles.reviewService}>{selected.title}</p>
                <p className={styles.reviewMeta}>
                  {selected.durationLabel} · {selected.priceLabel}
                  {appointmentWhen
                    ? ` · ${appointmentWhen.date} · ${appointmentWhen.timeRange}`
                    : ''}
                </p>
                <p className={styles.reviewTotal}>
                  <span>Total</span>
                  <span>{selected.priceLabel}</span>
                </p>
                <p className={styles.reviewNote}>
                  No charge today — a card is saved to hold your appointment.
                </p>
              </div>

              <hr className={styles.reviewRule} />

              <div className={styles.reviewBlock}>
                <p className={styles.reviewEyebrow}>Contact</p>
                <dl className={styles.contactDl}>
                  <div>
                    <dt>Name</dt>
                    <dd>{fullName}</dd>
                  </div>
                  <div>
                    <dt>Phone</dt>
                    <dd>{phone.trim()}</dd>
                  </div>
                  <div>
                    <dt>Updates</dt>
                    <dd>
                      {smsOptIn
                        ? 'Text messages opted in'
                        : email.trim()
                          ? `Email · ${email.trim()}`
                          : '—'}
                    </dd>
                  </div>
                </dl>
              </div>

              <hr className={styles.reviewRule} />

              <div className={styles.reviewBlock}>
                <p className={styles.policyTitle}>Cancellation</p>
                <p className={styles.policyCopy}>
                  24+ hours notice to cancel or reschedule. Inside 24 hours may
                  be charged up to 50%; no-shows (or cancels within 2 hours) may
                  be charged 100%.
                </p>
              </div>
            </div>
            {submitError && <p className={styles.error}>{submitError}</p>}
          </section>
        )}
      </main>

      {showReachPanel && (
        <div className={styles.reachOverlay} role="dialog" aria-modal="true">
          <div className={styles.reachCard}>
            <p className={styles.reachEyebrow}>Almost there</p>
            <p className={styles.reachTitle}>We need a way to reach you</p>
            <p className={styles.reachBody}>
              Check the box so we can text appointment updates. Your time is
              still held.
            </p>
            <label className={styles.reachSms}>
              <input
                type="checkbox"
                checked={smsOptIn}
                onChange={(e) => {
                  setSmsOptIn(e.target.checked);
                  setReachError(null);
                }}
              />
              <span>Yes, text me appointment updates from Sadie Marie</span>
            </label>
            {showEmailInReach && (
              <label className={styles.field}>
                <span>Email for appointment updates</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                />
              </label>
            )}
            {reachError && <p className={styles.error}>{reachError}</p>}
            <button
              type="button"
              className={styles.reachPrimary}
              onClick={continueFromReachPanel}
            >
              Continue
            </button>
            {!showEmailInReach && (
              <button
                type="button"
                className={styles.reachEmailToggle}
                onClick={() => {
                  setShowEmailInReach(true);
                  setReachError(null);
                }}
              >
                Prefer email instead?
              </button>
            )}
          </div>
        </div>
      )}
      {(step === 'when' || step === 'contact' || step === 'review') &&
        !showReachPanel && (
        <>
          {stripePromise && (step === 'contact' || step === 'review') ? (
            <Elements stripe={stripePromise} options={elementsOptions}>
              {/* Warm Apple Pay during contact so review does not flash Continue. */}
              {step === 'contact' ? (
                <ApplePayDetector onResult={onApplePayPrefetch} />
              ) : null}
              {step === 'review' && selected && selectedStart ? (
                <BookPayErrorBoundary
                  priceLabel={selected.priceLabel}
                  submitting={submitting}
                  onPayWithCard={() => void submitBooking()}
                >
                  <BookReviewPay
                    priceLabel={selected.priceLabel}
                    serviceTitle={selected.title}
                    servicePriceCents={selected.priceCents || 0}
                    selectedStart={selectedStart}
                    createPayload={createPayload}
                    submitting={submitting}
                    onSubmittingChange={setSubmitting}
                    onError={setSubmitError}
                    onCreateError={handleCreateError}
                    onPayWithCard={() => void submitBooking()}
                    onConfirmed={setConfirmed}
                    applePayPrefetch={applePayPrefetch}
                    prefersApplePay={prefersApplePay}
                    onApplePayResolved={onApplePayPrefetch}
                  />
                </BookPayErrorBoundary>
              ) : (
                <footer className={styles.footer}>
                  {selected && (
                    <div className={styles.footerTotal}>
                      <span className={styles.footerPrice}>
                        {selected.priceLabel}
                      </span>
                      <span className={styles.footerHint}>{selected.title}</span>
                    </div>
                  )}
                  {step === 'contact' && (
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={continueFromContact}
                    >
                      Continue
                    </button>
                  )}
                </footer>
              )}
            </Elements>
          ) : (
            <footer className={styles.footer}>
              {selected && (
                <div className={styles.footerTotal}>
                  <span className={styles.footerPrice}>{selected.priceLabel}</span>
                  <span className={styles.footerHint}>
                    {step === 'review' ? 'Then secure checkout' : selected.title}
                  </span>
                </div>
              )}
              {step === 'when' && (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={!selectedStart}
                  onClick={continueFromWhen}
                >
                  Continue
                </button>
              )}
              {step === 'contact' && (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={continueFromContact}
                >
                  Continue
                </button>
              )}
              {step === 'review' && (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={submitting}
                  onClick={() => void submitBooking()}
                >
                  {submitting ? 'Holding your time…' : 'Continue to checkout'}
                </button>
              )}
            </footer>
          )}
        </>
      )}
    </div>
  );
}
