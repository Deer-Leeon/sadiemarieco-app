/**
 * Booking-attempt funnel for /admin/funnel.
 * Quiet rows are classified when this is read (30 minutes). No cron.
 */

import { sql } from '@vercel/postgres';

import {
  BOOKING_ATTEMPT_ABANDON_MS,
  type BookingAttemptSurface,
} from '@/lib/booking-attempt';

type Stage = {
  id: string;
  label: string;
  steps: readonly string[];
};

const PHONE_STAGES: Stage[] = [
  { id: 'opened', label: 'Opened the booker', steps: ['opened'] },
  { id: 'service', label: 'Chose a service', steps: ['service'] },
  { id: 'time', label: 'Picked a time', steps: ['time'] },
  { id: 'contact', label: 'Entered details', steps: ['contact'] },
  { id: 'review', label: 'Reviewed the visit', steps: ['review'] },
  { id: 'pay', label: 'Payment', steps: ['pay', 'checkout', 'payment_attempt'] },
  { id: 'confirmed', label: 'Booked', steps: ['confirmed'] },
];

const DESKTOP_STAGES: Stage[] = [
  { id: 'opened', label: 'Opened a service', steps: ['opened'] },
  { id: 'cal_calendar', label: 'Choosing a day', steps: ['cal_calendar'] },
  { id: 'cal_time', label: 'Picked a time', steps: ['cal_time'] },
  {
    id: 'details',
    label: 'Entered details',
    steps: ['cal_details', 'details_submitted', 'contact'],
  },
  {
    id: 'pay',
    label: 'Payment',
    steps: ['pay_choice', 'checkout', 'payment_attempt'],
  },
  { id: 'confirmed', label: 'Booked', steps: ['confirmed'] },
];

export type CheckoutMethodCounts = {
  applePay: number;
  card: number;
  googlePay: number;
  link: number;
};

export type AttemptStageStat = {
  id: string;
  label: string;
  reached: number;
  left: number;
  leftPercent: number | null;
  medianMinutes: number | null;
};

export type AttemptSurfaceStat = {
  surface: BookingAttemptSurface;
  label: string;
  started: number;
  active: number;
  abandoned: number;
  confirmed: number;
  medianBookedMinutes: number | null;
  medianLeftMinutes: number | null;
  bookedByMethod: CheckoutMethodCounts;
  leftAtPaymentByMethod: CheckoutMethodCounts;
  stages: AttemptStageStat[];
};

export type AttemptFunnel = {
  started: number;
  active: number;
  abandoned: number;
  confirmed: number;
  medianBookedMinutes: number | null;
  medianLeftMinutes: number | null;
  bookedByMethod: CheckoutMethodCounts;
  leftAtPaymentByMethod: CheckoutMethodCounts;
  surfaces: AttemptSurfaceStat[];
};

type AttemptRow = {
  surface: string;
  started_at: Date | string;
  last_seen_at: Date | string;
  left_at: Date | string | null;
  completed_at: Date | string | null;
  last_step: string;
  checkout_method: string | null;
  steps: unknown;
};

const PAYMENT_STEPS = new Set([
  'pay',
  'checkout',
  'payment_attempt',
  'pay_choice',
]);

function emptyMethods(): CheckoutMethodCounts {
  return { applePay: 0, card: 0, googlePay: 0, link: 0 };
}

function addMethod(bucket: CheckoutMethodCounts, method: string | null) {
  if (method === 'apple_pay') bucket.applePay += 1;
  else if (method === 'card') bucket.card += 1;
  else if (method === 'google_pay') bucket.googlePay += 1;
  else if (method === 'link') bucket.link += 1;
}

function addMethodCounts(
  left: CheckoutMethodCounts,
  right: CheckoutMethodCounts
): CheckoutMethodCounts {
  return {
    applePay: left.applePay + right.applePay,
    card: left.card + right.card,
    googlePay: left.googlePay + right.googlePay,
    link: left.link + right.link,
  };
}

function stagesFor(surface: string): Stage[] {
  return surface === 'desktop' ? DESKTOP_STAGES : PHONE_STAGES;
}

function stageIndex(stages: Stage[], step: string): number {
  return stages.findIndex((stage) => stage.steps.includes(step));
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stepNames(raw: unknown, lastStep: string): string[] {
  const names: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && 'step' in entry) {
        const step = (entry as { step?: unknown }).step;
        if (typeof step === 'string') names.push(step);
      }
    }
  }
  if (lastStep) names.push(lastStep);
  return names;
}

function furthest(stages: Stage[], row: AttemptRow): number {
  let max = -1;
  for (const step of stepNames(row.steps, row.last_step)) {
    max = Math.max(max, stageIndex(stages, step));
  }
  return max;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(0, raw);
}

function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

function emptySurface(
  surface: BookingAttemptSurface,
  label: string
): AttemptSurfaceStat {
  const stages = stagesFor(surface).map((stage) => ({
    id: stage.id,
    label: stage.label,
    reached: 0,
    left: 0,
    leftPercent: null,
    medianMinutes: null,
  }));
  return {
    surface,
    label,
    started: 0,
    active: 0,
    abandoned: 0,
    confirmed: 0,
    medianBookedMinutes: null,
    medianLeftMinutes: null,
    bookedByMethod: emptyMethods(),
    leftAtPaymentByMethod: emptyMethods(),
    stages,
  };
}

function summarize(
  surface: BookingAttemptSurface,
  label: string,
  rows: AttemptRow[],
  now: Date
): AttemptSurfaceStat {
  const stages = stagesFor(surface);
  const reached = stages.map(() => 0);
  const left = stages.map(() => 0);
  const leftMinutes: number[][] = stages.map(() => []);
  const bookedMinutes: number[] = [];
  const abandonedMinutes: number[] = [];
  const bookedByMethod = emptyMethods();
  const leftAtPaymentByMethod = emptyMethods();
  let active = 0;
  let abandoned = 0;
  let confirmed = 0;

  for (const row of rows) {
    const started = asDate(row.started_at);
    if (!started) continue;
    const seen = asDate(row.last_seen_at) ?? started;
    const leftAt = asDate(row.left_at);
    const completed = asDate(row.completed_at);
    const isConfirmed = Boolean(completed);
    const quiet =
      now.getTime() - seen.getTime() >= BOOKING_ATTEMPT_ABANDON_MS;
    const isAbandoned = !isConfirmed && (Boolean(leftAt) || quiet);
    const end = completed ?? leftAt ?? seen;
    const duration = minutesBetween(started, end);
    const max = furthest(stages, row);

    if (isConfirmed) {
      confirmed += 1;
      bookedMinutes.push(duration);
      addMethod(bookedByMethod, row.checkout_method);
    } else if (isAbandoned) {
      abandoned += 1;
      abandonedMinutes.push(duration);
      if (row.checkout_method && PAYMENT_STEPS.has(row.last_step)) {
        addMethod(leftAtPaymentByMethod, row.checkout_method);
      }
      const stop = stageIndex(stages, row.last_step);
      if (stop >= 0 && stop < stages.length - 1) {
        left[stop] += 1;
        leftMinutes[stop].push(duration);
      }
    } else {
      active += 1;
    }

    const reachedThrough = isConfirmed ? stages.length - 1 : max;
    for (let i = 0; i <= reachedThrough && i < stages.length; i += 1) {
      reached[i] += 1;
    }
  }

  return {
    surface,
    label,
    started: rows.length,
    active,
    abandoned,
    confirmed,
    medianBookedMinutes: median(bookedMinutes),
    medianLeftMinutes: median(abandonedMinutes),
    bookedByMethod,
    leftAtPaymentByMethod,
    stages: stages.map((stage, index) => ({
      id: stage.id,
      label: stage.label,
      reached: reached[index],
      left: left[index],
      leftPercent:
        reached[index] > 0
          ? Math.round((left[index] / reached[index]) * 1000) / 10
          : null,
      medianMinutes: median(leftMinutes[index]),
    })),
  };
}

function combine(surfaces: AttemptSurfaceStat[]): AttemptFunnel {
  return {
    started: surfaces.reduce((sum, item) => sum + item.started, 0),
    active: surfaces.reduce((sum, item) => sum + item.active, 0),
    abandoned: surfaces.reduce((sum, item) => sum + item.abandoned, 0),
    confirmed: surfaces.reduce((sum, item) => sum + item.confirmed, 0),
    medianBookedMinutes: null,
    medianLeftMinutes: null,
    bookedByMethod: surfaces.reduce(
      (sum, item) => addMethodCounts(sum, item.bookedByMethod),
      emptyMethods()
    ),
    leftAtPaymentByMethod: surfaces.reduce(
      (sum, item) => addMethodCounts(sum, item.leftAtPaymentByMethod),
      emptyMethods()
    ),
    surfaces,
  };
}

export async function getBookingAttemptFunnel(
  rangeDays: number
): Promise<AttemptFunnel> {
  const now = new Date();
  const since = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  try {
    const { rows } = await sql<AttemptRow>`
      SELECT surface, started_at, last_seen_at, left_at, completed_at, last_step, checkout_method, steps
      FROM booking_attempts
      WHERE started_at >= ${sinceIso}
    `;
    const phone = summarize(
      'phone',
      'Phone',
      rows.filter((row) => row.surface === 'phone'),
      now
    );
    const desktop = summarize(
      'desktop',
      'Desktop',
      rows.filter((row) => row.surface === 'desktop'),
      now
    );
    const allBooked: number[] = [];
    const allLeft: number[] = [];
    for (const row of rows) {
      const started = asDate(row.started_at);
      if (!started) continue;
      const completed = asDate(row.completed_at);
      const leftAt = asDate(row.left_at);
      const seen = asDate(row.last_seen_at) ?? started;
      const quiet = now.getTime() - seen.getTime() >= BOOKING_ATTEMPT_ABANDON_MS;
      if (completed) {
        allBooked.push(minutesBetween(started, completed));
      } else if (leftAt || quiet) {
        allLeft.push(minutesBetween(started, leftAt ?? seen));
      }
    }
    const funnel = combine([phone, desktop]);
    funnel.medianBookedMinutes = median(allBooked);
    funnel.medianLeftMinutes = median(allLeft);
    return funnel;
  } catch (err) {
    console.warn('[booking-attempt] funnel read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    const funnel = combine([
      emptySurface('phone', 'Phone'),
      emptySurface('desktop', 'Desktop'),
    ]);
    return funnel;
  }
}

export function formatAttemptMinutes(value: number | null): string {
  if (value == null) return '—';
  if (value < 1) return '<1 min';
  const rounded = Math.round(value);
  return rounded === 1 ? '1 min' : `${rounded} min`;
}
