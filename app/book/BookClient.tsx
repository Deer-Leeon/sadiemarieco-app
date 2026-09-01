'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  formatCountdownMmSs,
  holdDeadlineMs,
  isHoldExpired,
} from '@/lib/booking-hold';
import {
  clientPhoneValidationMessage,
  formatUsPhoneAsYouType,
  parseClientPhone,
} from '@/lib/client-identity';
import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { stripePromise } from '@/lib/stripe-browser';
import {
  isKeepHoldThroughUnload,
  rememberActiveHoldUid,
  sendAbandonHoldBeacon,
  setKeepHoldThroughUnload,
} from '@/lib/abandon-hold-client';

import type { BookingPaymentTiming } from '@/lib/appointment-stripe';

import BookPayErrorBoundary from './BookPayErrorBoundary';
import BookApplePayHost, { type BookConfirmed } from './BookApplePayHost';
import BookTopBar from './BookTopBar';
import { CheckoutForm } from '@/app/checkout/CheckoutClient';
import styles from './book.module.css';

type Step = 'service' | 'when' | 'contact' | 'review' | 'pay';

/** Phone /book date strip (inclusive of today). */
const BOOK_AVAILABILITY_DAYS = 90;
/** First paint: load this many days before filling the rest in the background. */
const BOOK_SLOTS_INITIAL_DAYS = 21;
/** Cal range chunk size for background fills. */
const BOOK_SLOTS_CHUNK_DAYS = 21;
/** Days on each side of a restored selection that must be loaded before first paint. */
const BOOK_SLOTS_NEIGHBORHOOD_DAYS = 10;
/** Abort a hung slots request so the UI never spins forever. */
const BOOK_SLOTS_FETCH_TIMEOUT_MS = 12_000;
/** After releasing a hold, wait this long for Cal to return the slot. */
const SLOT_RELEASE_WAIT_MS = 15_000;
/** Extra beat after the slot reappears so Cal's embed cache can catch up. */
const SLOT_RELEASE_SETTLE_MS = 700;

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

function isoToStudioYmd(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function slotInstantMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function slotsIncludeInstant(
  slots: Record<string, string[]>,
  iso: string
): boolean {
  const ymd = isoToStudioYmd(iso);
  if (!ymd) return false;
  const times = slots[ymd] ?? [];
  const ms = slotInstantMs(iso);
  if (Number.isNaN(ms)) return times.includes(iso);
  const minute = Math.floor(ms / 60_000);
  return times.some((t) => {
    const other = slotInstantMs(t);
    if (Number.isNaN(other)) return t === iso;
    return Math.floor(other / 60_000) === minute;
  });
}

function mergeSlotIntoDay(
  slots: Record<string, string[]>,
  iso: string
): Record<string, string[]> {
  const ymd = isoToStudioYmd(iso);
  if (!ymd) return slots;
  const existing = slots[ymd] ?? [];
  const ms = slotInstantMs(iso);
  if (
    existing.includes(iso) ||
    (!Number.isNaN(ms) && existing.some((s) => slotInstantMs(s) === ms))
  ) {
    return slots;
  }
  return {
    ...slots,
    [ymd]: [...existing, iso].sort(
      (a, b) => slotInstantMs(a) - slotInstantMs(b)
    ),
  };
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function clampYmd(ymd: string, min: string, max: string): string {
  if (ymd < min) return min;
  if (ymd > max) return max;
  return ymd;
}

/** Mark every day in the requested range as fetched, even when Cal returned none. */
function withLoadedDays(
  slots: Record<string, string[]>,
  rangeStart: string,
  rangeEnd: string
): Record<string, string[]> {
  const next = { ...slots };
  if (rangeEnd < rangeStart) return next;
  let cursor = rangeStart;
  while (cursor <= rangeEnd) {
    if (!Object.prototype.hasOwnProperty.call(next, cursor)) {
      next[cursor] = [];
    }
    cursor = addDaysYmd(cursor, 1);
  }
  return next;
}

async function fetchBookSlots(
  slug: string,
  rangeStart: string,
  rangeEnd: string,
  parentSignal?: AbortSignal
): Promise<Record<string, string[]>> {
  const params = new URLSearchParams({
    slug,
    date: rangeStart,
    end: rangeEnd,
  });
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort);
  }
  const timer = window.setTimeout(
    () => controller.abort(),
    BOOK_SLOTS_FETCH_TIMEOUT_MS
  );
  try {
    const res = await fetch(`/api/book/slots?${params}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => null)) as {
      slots?: Record<string, string[]>;
      message?: string;
    } | null;
    if (!res.ok) {
      throw new Error(data?.message || 'Could not load times.');
    }
    return withLoadedDays(data?.slots ?? {}, rangeStart, rangeEnd);
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
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

function firstDayWithSlots(
  days: string[],
  slots: Record<string, string[]>
): string | null {
  return days.find((d) => (slots[d]?.length ?? 0) > 0) ?? null;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function splitPersonName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: '', last: '' };
  const space = trimmed.indexOf(' ');
  if (space < 0) return { first: trimmed, last: '' };
  return {
    first: trimmed.slice(0, space),
    last: trimmed.slice(space + 1).trim(),
  };
}

const STEPS: Step[] = ['service', 'when', 'contact', 'review', 'pay'];

function BookDayScroller({
  dayOptions,
  slotsByDay,
  selectedDay,
  onSelectDay,
}: {
  dayOptions: string[];
  slotsByDay: Record<string, string[]>;
  selectedDay: string;
  onSelectDay: (ymd: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);

  const updateFades = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft;
    setCanScrollLeft(left > 4);
    setCanScrollRight(maxScroll > 4 && left < maxScroll - 4);
    if (left > 8) setHasScrolled(true);
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => updateFades();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateFades());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [updateFades, dayOptions.length, selectedDay]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !selectedDay) return;
    const chip = el.querySelector(`[data-day="${selectedDay}"]`);
    if (!(chip instanceof HTMLElement)) return;
    chip.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'auto',
    });
    updateFades();
  }, [selectedDay, dayOptions.length, updateFades]);

  return (
    <div className={styles.dayScrollerWrap}>
      {!hasScrolled && canScrollRight ? (
        <p className={styles.dayScrollHint}>Swipe for more dates →</p>
      ) : (
        <p className={styles.dayScrollHint}>Pick a date</p>
      )}
      <div
        className={`${styles.dayScrollerFadeLeft} ${
          canScrollLeft ? styles.dayScrollerFadeOn : ''
        }`}
        aria-hidden="true"
      />
      <div
        className={`${styles.dayScrollerFadeRight} ${
          canScrollRight ? styles.dayScrollerFadeOn : ''
        }`}
        aria-hidden="true"
      />
      <div
        ref={scrollerRef}
        className={styles.dayScroller}
        role="listbox"
        aria-label="Available dates. Swipe horizontally for more."
      >
        {dayOptions.map((ymd) => {
          const chip = formatDayChip(ymd);
          const loaded = Object.prototype.hasOwnProperty.call(slotsByDay, ymd);
          const count = slotsByDay[ymd]?.length ?? 0;
          const active = ymd === selectedDay;
          const pending = !loaded && !active;
          return (
            <button
              key={ymd}
              type="button"
              role="option"
              data-day={ymd}
              aria-selected={active}
              disabled={pending || (loaded && count === 0 && !active)}
              className={`${styles.dayChip} ${active ? styles.dayChipOn : ''} ${
                pending ? styles.dayChipPending : ''
              }`}
              onClick={() => onSelectDay(ymd)}
            >
              <span>{chip.weekday}</span>
              <span>{chip.monthDay}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function BookClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const presetSlug = searchParams.get('service')?.trim() ?? '';
  const resumeUidParam = searchParams.get('resume_checkout')?.trim() ?? '';

  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step>(() =>
    resumeUidParam ? 'pay' : 'service'
  );
  const [services, setServices] = useState<BookService[]>([]);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BookService | null>(null);

  const [dayOptions, setDayOptions] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>('');
  const [slotsByDay, setSlotsByDay] = useState<Record<string, string[]>>({});
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsLoadingLabel, setSlotsLoadingLabel] = useState('Loading times…');
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
  const [paymentTiming, setPaymentTiming] =
    useState<BookingPaymentTiming>('pay_later');
  const [holdUid, setHoldUid] = useState<string | null>(null);
  const [holdCreatedAt, setHoldCreatedAt] = useState<string | null>(null);
  const [holdCountdown, setHoldCountdown] = useState('');
  const [holdExpired, setHoldExpired] = useState(false);

  const [applePayAvailable, setApplePayAvailable] = useState<boolean | null>(
    null
  );
  const [applePayReady, setApplePayReady] = useState(false);
  const [showCardCheckout, setShowCardCheckout] = useState(false);
  const resumeAppliedRef = useRef(false);
  const holdUidRef = useRef<string | null>(null);
  const confirmedRef = useRef<BookConfirmed | null>(null);
  const slotsLoadGenRef = useRef(0);
  const slotsAbortRef = useRef<AbortController | null>(null);
  const slotsByDayRef = useRef<Record<string, string[]>>({});
  holdUidRef.current = holdUid;
  confirmedRef.current = confirmed;
  rememberActiveHoldUid(holdUid);
  slotsByDayRef.current = slotsByDay;

  const onApplePayResolved = useCallback((available: boolean) => {
    setApplePayReady(true);
    setApplePayAvailable((prev) => (prev === true ? true : available));
  }, []);

  const elementsAppearance = useMemo(
    () => ({
      theme: 'flat' as const,
      variables: {
        colorPrimary: '#0d1b2a',
        borderRadius: '0px',
      },
    }),
    []
  );

  // Dual Elements (setup + payment) stay mounted across review → pay and
  // radio switches so Apple Pay never remounts / reanimates.
  const setupElementsOptions: StripeElementsOptions = useMemo(
    () => ({
      mode: 'setup',
      currency: 'usd',
      paymentMethodTypes: ['card'],
      setupFutureUsage: 'off_session',
      appearance: elementsAppearance,
    }),
    [elementsAppearance]
  );

  const selectedPriceCents = selected?.priceCents ?? null;
  const paymentElementsOptions: StripeElementsOptions = useMemo(() => {
    const amount =
      selectedPriceCents && selectedPriceCents > 0 ? selectedPriceCents : 50;
    return {
      mode: 'payment',
      amount,
      currency: 'usd',
      paymentMethodTypes: ['card'],
      // Must match PaymentIntent setup_future_usage or Apple Pay confirm fails.
      setupFutureUsage: 'off_session',
      appearance: elementsAppearance,
    };
  }, [elementsAppearance, selectedPriceCents]);

  useEffect(() => {
    if (!isPhoneViewport()) {
      window.location.replace('/#services');
      return;
    }
    setReady(true);
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
        const resumeUid = searchParams.get('resume_checkout')?.trim() ?? '';
        if (
          presetSlug &&
          !resumeUid &&
          !holdUidRef.current &&
          !resumeAppliedRef.current
        ) {
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
  }, [ready, presetSlug, searchParams]);

  useEffect(() => {
    if (!ready || resumeAppliedRef.current || services.length === 0) return;
    const uid = searchParams.get('resume_checkout')?.trim() ?? '';
    if (!uid) return;
    resumeAppliedRef.current = true;

    const urlName = searchParams.get('name')?.trim() ?? '';
    const urlEmail = searchParams.get('email')?.trim() ?? '';
    const urlPhone = searchParams.get('phone')?.trim() ?? '';
    const urlService = searchParams.get('service')?.trim() ?? '';
    const urlTime = searchParams.get('time')?.trim() ?? '';

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/booking/hold?uid=${encodeURIComponent(uid)}`
        );
        const data = (await res.json().catch(() => null)) as {
          createdAt?: string | null;
          expired?: boolean;
          bookingTime?: string | null;
          serviceName?: string | null;
        } | null;
        if (cancelled) return;
        const bookingTime = (data?.bookingTime || urlTime || '').trim();
        const serviceName = (data?.serviceName || urlService || '').trim();
        const needle = serviceName.toLowerCase();
        const match =
          services.find((s) => s.title.toLowerCase() === needle) ||
          services.find((s) => s.slug.toLowerCase() === needle) ||
          services.find(
            (s) => needle.length > 0 && s.title.toLowerCase().includes(needle)
          ) ||
          services[0] ||
          null;
        if (match) setSelected(match);
        if (bookingTime) {
          setSelectedStart(bookingTime);
          const ymd = isoToStudioYmd(bookingTime);
          if (ymd) setSelectedDay(ymd);
        }
        const parts = splitPersonName(urlName);
        if (parts.first) setFirstName(parts.first);
        if (parts.last) setLastName(parts.last);
        if (urlPhone) setPhone(formatUsPhoneAsYouType(urlPhone));
        if (urlEmail) setEmail(urlEmail);
        setHoldUid(uid);
        if (data?.createdAt) setHoldCreatedAt(data.createdAt);
        if (data?.expired) setHoldExpired(true);
        setStep('pay');

        const url = new URL(window.location.href);
        ['resume_checkout', 'name', 'email', 'phone', 'service', 'time'].forEach(
          (key) => url.searchParams.delete(key)
        );
        const qs = url.searchParams.toString();
        window.history.replaceState(
          {},
          '',
          qs ? `${url.pathname}?${qs}` : url.pathname
        );
      } catch {
        if (!cancelled) resumeAppliedRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, services, searchParams]);

  const loadSlots = useCallback(
    async (
      slug: string,
      options?: {
        keepSelection?: boolean;
        restoreStart?: string | null;
        waitForRestore?: boolean;
      }
    ) => {
      const restoreStart = options?.restoreStart ?? null;
      const waitForRestore = Boolean(options?.waitForRestore && restoreStart);
      const keepSelection = Boolean(options?.keepSelection);

      const applyRestore = (incoming: Record<string, string[]>) => {
        if (!restoreStart) return incoming;
        return mergeSlotIntoDay(incoming, restoreStart);
      };

      const restoreCachedSelection = () => {
        if (!restoreStart) return;
        setSlotsByDay((prev) => mergeSlotIntoDay(prev, restoreStart));
        const ymd = isoToStudioYmd(restoreStart);
        if (ymd) setSelectedDay(ymd);
        setSelectedStart(restoreStart);
      };

      // Returning to this screen: keep the already-loaded 90-day map so
      // neighbors of a far-out day don't flash "unavailable" while chunks
      // refetch. Don't abort an in-flight background fill.
      if (keepSelection) {
        setSlotsError(null);
        setSlotsLoading(false);
        if (waitForRestore && restoreStart) {
          const ymd = isoToStudioYmd(restoreStart);
          const deadline = Date.now() + SLOT_RELEASE_WAIT_MS;
          while (Date.now() < deadline) {
            try {
              const probe = ymd
                ? await fetchBookSlots(slug, ymd, ymd)
                : {};
              if (slotsIncludeInstant(probe, restoreStart)) {
                await sleepMs(SLOT_RELEASE_SETTLE_MS);
                setSlotsByDay((prev) => applyRestore({ ...prev, ...probe }));
                if (ymd) setSelectedDay(ymd);
                setSelectedStart(restoreStart);
                return;
              }
            } catch (err) {
              if (isAbortError(err)) return;
            }
            await sleepMs(400);
          }
        }
        restoreCachedSelection();
        return;
      }

      const loadGen = slotsLoadGenRef.current + 1;
      slotsLoadGenRef.current = loadGen;
      slotsAbortRef.current?.abort();
      const loadAbort = new AbortController();
      slotsAbortRef.current = loadAbort;
      const stillCurrent = () =>
        slotsLoadGenRef.current === loadGen && !loadAbort.signal.aborted;

      setSlotsLoadingLabel(
        waitForRestore ? 'Refreshing the calendar…' : 'Checking the calendar…'
      );
      setSlotsLoading(true);
      setSlotsError(null);
      const start = studioTodayYmd();
      const lastDay = addDaysYmd(start, BOOK_AVAILABILITY_DAYS - 1);
      const days: string[] = [];
      for (let i = 0; i < BOOK_AVAILABILITY_DAYS; i += 1) {
        days.push(addDaysYmd(start, i));
      }
      setDayOptions(days);
      const restoreDay = restoreStart ? isoToStudioYmd(restoreStart) : null;
      setSelectedDay(restoreDay || '');
      if (!restoreStart) setSelectedStart(null);
      setSlotsByDay({});

      const fetchRange = (rangeStart: string, rangeEnd: string) =>
        fetchBookSlots(slug, rangeStart, rangeEnd, loadAbort.signal);

      const paintSlots = (
        incoming: Record<string, string[]>,
        day: string,
        startIso: string | null
      ) => {
        if (!stillCurrent()) return;
        setSlotsByDay(incoming);
        if (day) setSelectedDay(day);
        if (startIso) setSelectedStart(startIso);
        setSlotsLoading(false);
        setSlotsLoadingLabel('Checking the calendar…');
      };

      try {
        if (waitForRestore && restoreStart) {
          const ymd = isoToStudioYmd(restoreStart);
          const deadline = Date.now() + SLOT_RELEASE_WAIT_MS;
          while (Date.now() < deadline && stillCurrent()) {
            try {
              const probe = ymd ? await fetchRange(ymd, ymd) : {};
              if (slotsIncludeInstant(probe, restoreStart)) {
                await sleepMs(SLOT_RELEASE_SETTLE_MS);
                break;
              }
            } catch (err) {
              if (isAbortError(err)) return;
            }
            await sleepMs(400);
          }
        }

        if (!stillCurrent()) return;

        let merged: Record<string, string[]> = {};
        let offset = 0;
        let painted = false;

        while (offset < BOOK_AVAILABILITY_DAYS && stillCurrent()) {
          const chunkDays =
            offset === 0 ? BOOK_SLOTS_INITIAL_DAYS : BOOK_SLOTS_CHUNK_DAYS;
          const rangeStart = addDaysYmd(start, offset);
          const rangeEnd = addDaysYmd(
            start,
            Math.min(offset + chunkDays, BOOK_AVAILABILITY_DAYS) - 1
          );

          if (restoreStart && offset === 0) {
            const ymd = isoToStudioYmd(restoreStart);
            const firstEnd = rangeEnd;
            if (!ymd) {
              const more = await fetchRange(rangeStart, rangeEnd);
              if (!stillCurrent()) return;
              merged = { ...merged, ...more };
              paintSlots(merged, start, restoreStart);
              painted = true;
              offset += chunkDays;
              break;
            }
            const nbStart = clampYmd(
              addDaysYmd(ymd, -BOOK_SLOTS_NEIGHBORHOOD_DAYS),
              start,
              lastDay
            );
            const nbEnd = clampYmd(
              addDaysYmd(ymd, BOOK_SLOTS_NEIGHBORHOOD_DAYS),
              start,
              lastDay
            );
            const needNeighborhood = nbEnd > firstEnd || ymd < start;
            const extraPromise = needNeighborhood
              ? fetchRange(nbStart, nbEnd)
              : Promise.resolve({} as Record<string, string[]>);
            const [first, extra] = await Promise.all([
              fetchRange(rangeStart, rangeEnd),
              extraPromise,
            ]);
            if (!stillCurrent()) return;
            merged = { ...first, ...extra };
            if (!slotsIncludeInstant(merged, restoreStart)) {
              merged = mergeSlotIntoDay(merged, restoreStart);
            }
            paintSlots(merged, ymd, restoreStart);
            painted = true;
            offset += chunkDays;
            break;
          }

          const more = await fetchRange(rangeStart, rangeEnd);
          if (!stillCurrent()) return;
          merged = { ...merged, ...more };

          const first = firstDayWithSlots(days, merged);
          if (first) {
            paintSlots(merged, first, null);
            painted = true;
            offset += chunkDays;
            break;
          }
          offset += chunkDays;
        }

        if (!painted && stillCurrent()) {
          paintSlots(merged, start, null);
        }

        for (
          ;
          offset < BOOK_AVAILABILITY_DAYS && stillCurrent();
          offset += BOOK_SLOTS_CHUNK_DAYS
        ) {
          const rangeStart = addDaysYmd(start, offset);
          const rangeEnd = addDaysYmd(
            start,
            Math.min(offset + BOOK_SLOTS_CHUNK_DAYS, BOOK_AVAILABILITY_DAYS) - 1
          );
          try {
            const more = await fetchRange(rangeStart, rangeEnd);
            if (!stillCurrent()) return;
            setSlotsByDay((prev) => applyRestore({ ...prev, ...more }));
          } catch (err) {
            if (isAbortError(err)) return;
            break;
          }
        }
      } catch (err) {
        if (!stillCurrent() || isAbortError(err)) return;
        if (restoreStart) {
          restoreCachedSelection();
          setSlotsLoading(false);
          return;
        }
        setSlotsError(
          err instanceof Error ? err.message : 'Could not load times.'
        );
        setSlotsByDay({});
        setSlotsLoading(false);
      }
    },
    []
  );

  const slotsLoadedForSlugRef = useRef<string | null>(null);

  useEffect(() => {
    if (resumeUidParam) return;
    if (step !== 'when' || !selected?.slug) return;
    if (slotsLoadedForSlugRef.current === selected.slug) return;
    slotsLoadedForSlugRef.current = selected.slug;
    void loadSlots(selected.slug);
  }, [step, selected?.slug, loadSlots, resumeUidParam]);

  useEffect(() => {
    return () => {
      slotsAbortRef.current?.abort();
    };
  }, []);

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
    const paymentIntentId = searchParams.get('payment_intent')?.trim() ?? '';
    const uid = searchParams.get('uid')?.trim() ?? '';
    const resumeName = searchParams.get('name')?.trim() ?? '';
    const resumeEmail = searchParams.get('email')?.trim() ?? '';
    const hasSetup = setupIntentId.startsWith('seti_');
    const hasPayment = paymentIntentId.startsWith('pi_');
    if (
      redirectStatus !== 'succeeded' ||
      hasSetup === hasPayment ||
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
            ...(hasPayment
              ? { paymentIntentId }
              : { setupIntentId }),
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
              (hasPayment
                ? 'Your payment went through but we could not confirm the appointment.'
                : 'Your card was saved but we could not confirm the appointment.')
          );
          return;
        }
        trackBook(BOOKING_ANALYTICS_EVENTS.BOOKING_CONFIRMED, {
          source: 'phone_booker_apple_pay',
          payment_timing: hasPayment ? 'pay_now' : 'pay_later',
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
        url.searchParams.delete('payment_intent');
        url.searchParams.delete('payment_intent_client_secret');
        url.searchParams.delete('redirect_status');
        url.searchParams.delete('payTiming');
        const qs = url.searchParams.toString();
        window.history.replaceState(
          {},
          '',
          qs ? `${url.pathname}?${qs}` : url.pathname
        );
      } catch {
        if (!cancelled) {
          setSubmitError(
            hasPayment
              ? 'Your payment went through but we could not confirm the appointment.'
              : 'Your card was saved but we could not confirm the appointment.'
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

  const clearHoldState = useCallback(() => {
    rememberActiveHoldUid(null);
    setHoldUid(null);
    setHoldCreatedAt(null);
    setHoldCountdown('');
    setHoldExpired(false);
  }, []);

  const abandonHold = useCallback(
    async (uid: string | null = holdUid) => {
      if (!uid) {
        clearHoldState();
        return;
      }
      try {
        await fetch('/api/booking/abandon-hold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calBookingUid: uid }),
          keepalive: true,
        });
      } catch {
        /* best-effort — QStash still releases at window end */
      }
      clearHoldState();
    },
    [holdUid, clearHoldState]
  );

  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      if (isKeepHoldThroughUnload()) return;
      if (confirmedRef.current) return;
      sendAbandonHoldBeacon(holdUidRef.current);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  useEffect(() => {
    if (!holdCreatedAt || holdExpired) {
      setHoldCountdown('');
      return;
    }
    const tick = () => {
      const remaining = holdDeadlineMs(holdCreatedAt) - Date.now();
      if (remaining <= 0) {
        setHoldCountdown('00:00');
        setHoldExpired(true);
        return;
      }
      setHoldCountdown(formatCountdownMmSs(remaining));
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [holdCreatedAt, holdExpired]);

  useEffect(() => {
    if (!holdExpired || !holdUid) return;
    const uid = holdUid;
    const releasedStart = selectedStart;
    const hasCache = Object.keys(slotsByDayRef.current).length > 0;
    void (async () => {
      if (!hasCache) {
        setSlotsLoadingLabel('Refreshing the calendar…');
        setSlotsLoading(true);
        setSlotsByDay({});
      }
      await abandonHold(uid);
      setStep('when');
      if (selected?.slug) {
        await loadSlots(selected.slug, {
          restoreStart: releasedStart,
          waitForRestore: Boolean(releasedStart),
          keepSelection: hasCache,
        });
      }
      setSubmitError(
        'Your 10-minute hold expired. Please pick a time again.'
      );
    })();
  }, [holdExpired, holdUid, abandonHold, selected?.slug, selectedStart, loadSlots]);

  const goBack = () => {
    if (showCardCheckout) {
      setShowCardCheckout(false);
      setSubmitError(null);
      return;
    }
    if (showReachPanel) {
      setShowReachPanel(false);
      setShowEmailInReach(false);
      setReachError(null);
      return;
    }
    if (step === 'service') {
      void abandonHold();
      router.push('/#services');
      return;
    }
    const prev = STEPS[Math.max(0, stepIndex - 1)];
    if (prev === 'when' || prev === 'service') {
      const releasedStart = selectedStart;
      const slug = selected?.slug;
      const uidToRelease = holdUid;
      const hasCache = Object.keys(slotsByDayRef.current).length > 0;
      if (prev === 'when' && !hasCache) {
        setSlotsLoadingLabel('Refreshing the calendar…');
        setSlotsLoading(true);
        setSlotsByDay({});
      }
      clearHoldState();
      void (async () => {
        await abandonHold(uidToRelease);
        if (prev === 'when' && slug) {
          await loadSlots(slug, {
            restoreStart: releasedStart,
            waitForRestore: Boolean(releasedStart) && !hasCache,
            keepSelection: hasCache,
          });
        }
      })();
    }
    setStep(prev);
    setSubmitError(null);
    setContactError(null);
  };

  const pickService = (service: BookService) => {
    void abandonHold();
    slotsLoadedForSlugRef.current = null;
    slotsAbortRef.current?.abort();
    setSelected(service);
    setSelectedStart(null);
    setSelectedDay('');
    setSlotsByDay({});
    setSlotsLoading(true);
    setSlotsLoadingLabel('Checking the calendar…');
    setSlotsError(null);
    setShowCardCheckout(false);
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
    if (!parseClientPhone(phone)) {
      setContactError(clientPhoneValidationMessage());
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

  const continueFromReview = async () => {
    setSubmitError(null);
    if (holdUid && holdCreatedAt && !isHoldExpired(holdCreatedAt)) {
      try {
        await fetch('/api/booking/update-contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              calBookingUid: holdUid,
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              phone: phone.trim(),
              email: email.trim() || undefined,
            }),
          });
        } catch {
          /* confirm still uses the latest name/phone from this page */
        }
      setStep('pay');
      return;
    }

    if (!selected || !selectedStart || submitting) return;
    setSubmitting(true);
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
        createdAt?: string;
        name?: string;
        email?: string;
        error?: string;
        message?: string;
      } | null;

      if (!res.ok || !data?.calBookingUid) {
        handleCreateError(data);
        return;
      }

      setHoldUid(data.calBookingUid);
      setHoldCreatedAt(data.createdAt || new Date().toISOString());
      setHoldExpired(false);
      setStep('pay');
    } catch {
      setSubmitError('Could not hold that time. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitBooking = async () => {
    if (!selected || !selectedStart || submitting || confirmed) return;
    const uid = holdUid;
    if (!uid) {
      setSubmitError('Your time hold is missing. Go back and continue again.');
      return;
    }
    setSubmitError(null);
    if (!stripePromise) {
      const params = new URLSearchParams({ uid });
      if (fullName) params.set('name', fullName);
      if (email.trim()) params.set('email', email.trim());
      if (phone.trim()) params.set('phone', phone.trim());
      params.set('payMode', paymentTiming === 'pay_now' ? 'now' : 'later');
      setKeepHoldThroughUnload(true);
      window.location.assign(`/checkout?${params.toString()}`);
      return;
    }
    setShowCardCheckout(true);
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
        <BookTopBar />
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
            : step === 'pay'
              ? 'Payment'
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
        <BookTopBar />
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
                Your booking is recorded, but we couldn&apos;t finalise the
                calendar invite automatically. The studio will confirm with you
                shortly.
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
      <BookTopBar
        showBack={step !== 'service'}
        onBack={goBack}
        onHomeClick={() => {
          void abandonHold();
        }}
      />

      <div className={styles.progress} aria-hidden="true">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`${styles.progressDot} ${i <= stepIndex ? styles.progressDotOn : ''}`}
          />
        ))}
      </div>

      <main
        className={`${styles.main} ${
          step === 'review' || step === 'pay' ? styles.mainReview : ''
        }`}
      >
        <div
          className={`${styles.titleRow} ${
            step === 'review' || step === 'pay' ? styles.titleRowReview : ''
          }`}
        >
          <h1
            className={`${styles.title} ${
              step === 'review' || step === 'pay' ? styles.titleReview : ''
            }`}
          >
            {stepTitle}
          </h1>
          {step === 'pay' && holdCountdown ? (
            <p
              className={styles.holdTimer}
              aria-live="polite"
              aria-label={`Time remaining ${holdCountdown}`}
            >
              {holdCountdown}
            </p>
          ) : null}
        </div>

        {step === 'service' && !resumeUidParam && (
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

        {step === 'when' && selected && !resumeUidParam && (
          <section className={styles.section}>
            <p className={styles.selectedService}>
              {selected.title} · {selected.priceLabel} · {selected.durationLabel}
            </p>
            {slotsError && <p className={styles.error}>{slotsError}</p>}
            {slotsLoading ? (
              <div
                className={styles.calendarStatus}
                role="status"
                aria-live="polite"
              >
                <p className={styles.calendarStatusTitle}>
                  {slotsLoadingLabel}
                </p>
                <p className={styles.calendarStatusHint}>
                  Open times will appear in a moment.
                </p>
              </div>
            ) : null}
            {!slotsLoading && selectedDay && dayOptions.length > 0 ? (
              <BookDayScroller
                dayOptions={dayOptions}
                slotsByDay={slotsByDay}
                selectedDay={selectedDay}
                onSelectDay={(ymd) => {
                  setSelectedDay(ymd);
                  setSelectedStart(null);
                }}
              />
            ) : null}
            {!slotsLoading && !slotsError && selectedDay && (
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
                type="tel"
                value={phone}
                onChange={(e) => setPhone(formatUsPhoneAsYouType(e.target.value))}
                autoComplete="tel"
                inputMode="numeric"
                maxLength={14}
                placeholder="(555) 123-4567"
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
                  Next you&apos;ll choose pay now or pay later in studio.
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

        {step === 'pay' && selected && selectedStart && showCardCheckout && holdUid ? (
          <section className={`${styles.section} ${styles.reviewSection}`}>
            <Elements
              key={paymentTiming === 'pay_now' ? 'card-payment' : 'card-setup'}
              stripe={stripePromise}
              options={
                paymentTiming === 'pay_now'
                  ? paymentElementsOptions
                  : setupElementsOptions
              }
            >
              <CheckoutForm
                uid={holdUid}
                name={fullName}
                email={email.trim()}
                holdExpired={holdExpired}
                service={analyticsServiceLabel(selected.title)}
                payNow={paymentTiming === 'pay_now'}
                quotedServicePriceCents={selected.priceCents}
                returnPath="/book"
                onBack={() => {
                  setShowCardCheckout(false);
                  setSubmitError(null);
                }}
                onConfirmed={(result) =>
                  setConfirmed({
                    name: fullName,
                    calWarning: result.calWarning,
                    contact: result.contact,
                  })
                }
              />
            </Elements>
          </section>
        ) : null}

        {step === 'pay' && (!selected || !selectedStart) ? (
          <section className={styles.section}>
            <div
              className={styles.calendarStatus}
              role="status"
              aria-live="polite"
            >
              <p className={styles.calendarStatusTitle}>
                Preparing checkout…
              </p>
              <p className={styles.calendarStatusHint}>
                Your appointment hold is still in place.
              </p>
            </div>
          </section>
        ) : null}

        {step === 'pay' && selected && selectedStart && (
          <section
            className={`${styles.section} ${styles.reviewSection}`}
            hidden={showCardCheckout}
            aria-hidden={showCardCheckout}
          >
            <div className={styles.reviewSheet}>
              <div className={styles.reviewBlock}>
                <p className={styles.reviewEyebrow}>Due today</p>
                <p className={styles.reviewTotal}>
                  <span>
                    {paymentTiming === 'pay_now' ? 'Pay now' : 'Pay later'}
                  </span>
                  <span>
                    {paymentTiming === 'pay_now'
                      ? selected.priceLabel
                      : '$0'}
                  </span>
                </p>
              </div>

              <fieldset className={styles.payOptions}>
                <legend className={styles.srOnly}>Payment timing</legend>
                <label
                  className={`${styles.payOption} ${
                    paymentTiming === 'pay_later' ? styles.payOptionOn : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentTiming"
                    value="pay_later"
                    checked={paymentTiming === 'pay_later'}
                    onChange={() => setPaymentTiming('pay_later')}
                  />
                  <span className={styles.payOptionBody}>
                    <span className={styles.payOptionTitle}>
                      Pay later in studio
                    </span>
                    <span className={styles.payOptionHint}>
                      Card saved to hold — pay at your visit
                    </span>
                  </span>
                </label>
                <label
                  className={`${styles.payOption} ${
                    paymentTiming === 'pay_now' ? styles.payOptionOn : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentTiming"
                    value="pay_now"
                    checked={paymentTiming === 'pay_now'}
                    onChange={() => setPaymentTiming('pay_now')}
                  />
                  <span className={styles.payOptionBody}>
                    <span className={styles.payOptionTitle}>
                      Pay now in full
                    </span>
                    <span className={styles.payOptionHint}>
                      Save time at your appointment — charged{' '}
                      {selected.priceLabel} now
                    </span>
                  </span>
                </label>
              </fieldset>

              <hr className={styles.reviewRule} />

              <div className={styles.reviewBlock}>
                <p className={styles.policyTitle}>Cancellation</p>
                <p className={styles.policyCopy}>
                  24+ hours notice to cancel or reschedule. Inside 24 hours may
                  be charged up to 50%; no-shows (or cancels within 2 hours) may
                  be charged 100%. A card on file is required either way.
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
      {((step === 'when' && !slotsLoading && !resumeUidParam) ||
        step === 'contact' ||
        step === 'review') &&
        !showReachPanel && (
        <footer className={styles.footer}>
          {selected && (
            <div className={styles.footerTotal}>
              <span className={styles.footerPrice}>{selected.priceLabel}</span>
              <span className={styles.footerHint}>
                {step === 'review' ? 'Continue to payment' : selected.title}
              </span>
            </div>
          )}
          {step === 'when' && (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={!selectedStart || slotsLoading}
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
              onClick={() => void continueFromReview()}
            >
              {submitting ? 'Holding your time…' : 'Continue'}
            </button>
          )}
        </footer>
      )}

      {/* Warm Apple Pay on review; same instances become the pay dock. */}
      {stripePromise &&
        selected &&
        selectedStart &&
        (step === 'review' || step === 'pay') &&
        !showReachPanel && (
          <div
            className={
              step === 'pay' && !showCardCheckout
                ? `${styles.footer} ${styles.footerStack}`
                : styles.payWarmShell
            }
            aria-hidden={step !== 'pay' || showCardCheckout}
          >
            {step === 'pay' && !showCardCheckout ? (
              <div className={styles.footerTotal}>
                <span className={styles.footerPrice}>
                  {paymentTiming === 'pay_now' ? selected.priceLabel : '$0'}
                </span>
                <span className={styles.footerHint}>
                  {paymentTiming === 'pay_now'
                    ? 'Charged now — card also saved for your appointment'
                    : 'No charge today — Apple Pay saves your card'}
                </span>
              </div>
            ) : null}

            <div className={styles.expressCheckout}>
              <BookPayErrorBoundary
                priceLabel={selected.priceLabel}
                submitting={submitting}
                onPayWithCard={() => void submitBooking()}
              >
                <Elements stripe={stripePromise} options={setupElementsOptions}>
                  <BookApplePayHost
                    active={step === 'pay' && paymentTiming === 'pay_later'}
                    paymentTiming="pay_later"
                    serviceTitle={selected.title}
                    createPayload={createPayload}
                    calBookingUid={holdUid}
                    submitting={submitting}
                    onSubmittingChange={setSubmitting}
                    onError={setSubmitError}
                    onCreateError={handleCreateError}
                    onConfirmed={setConfirmed}
                    onApplePayResolved={onApplePayResolved}
                  />
                </Elements>
                <Elements
                  stripe={stripePromise}
                  options={paymentElementsOptions}
                >
                  <BookApplePayHost
                    active={step === 'pay' && paymentTiming === 'pay_now'}
                    paymentTiming="pay_now"
                    serviceTitle={selected.title}
                    createPayload={createPayload}
                    calBookingUid={holdUid}
                    submitting={submitting}
                    onSubmittingChange={setSubmitting}
                    onError={setSubmitError}
                    onCreateError={handleCreateError}
                    onConfirmed={setConfirmed}
                    onApplePayResolved={onApplePayResolved}
                  />
                </Elements>
              </BookPayErrorBoundary>
            </div>

            {step === 'pay' &&
            !showCardCheckout &&
            applePayAvailable !== false ? (
              <button
                type="button"
                className={styles.textLinkBtn}
                disabled={submitting}
                onClick={() => void submitBooking()}
              >
                Pay with card instead
              </button>
            ) : null}

            {step === 'pay' &&
            !showCardCheckout &&
            applePayReady &&
            applePayAvailable === false ? (
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={submitting}
                onClick={() => void submitBooking()}
              >
                {submitting
                  ? 'Opening card checkout…'
                  : paymentTiming === 'pay_now'
                    ? 'Pay with card'
                    : 'Continue with card'}
              </button>
            ) : null}
          </div>
        )}

      {step === 'pay' &&
        selected &&
        selectedStart &&
        !showReachPanel &&
        !stripePromise && (
          <footer className={`${styles.footer} ${styles.footerStack}`}>
            <div className={styles.footerTotal}>
              <span className={styles.footerPrice}>
                {paymentTiming === 'pay_now' ? selected.priceLabel : '$0'}
              </span>
              <span className={styles.footerHint}>
                {paymentTiming === 'pay_now'
                  ? 'Pay now in full'
                  : 'Then secure checkout'}
              </span>
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={submitting}
              onClick={() => void submitBooking()}
            >
              {submitting
                ? 'Opening card checkout…'
                : paymentTiming === 'pay_now'
                  ? 'Pay with card'
                  : 'Continue with card'}
            </button>
          </footer>
        )}
    </div>
  );
}
