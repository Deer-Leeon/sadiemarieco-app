/**
 * Public booking-attempt sessions for /admin/funnel.
 *
 * A start is one visit: opening /book (phone) or a service drawer (desktop).
 * Another service in that same tab continues the visit. Steps are appended
 * only when they move forward. Closing the tab sets left_at.
 * Quiet rows are treated as abandoned when the funnel page is read
 * (30 minutes) — there is no cron. No name, phone, or email is stored.
 */

import { sql } from '@vercel/postgres';

export const BOOKING_ATTEMPT_SURFACES = ['phone', 'desktop'] as const;
export type BookingAttemptSurface = (typeof BOOKING_ATTEMPT_SURFACES)[number];

export const BOOKING_ATTEMPT_STEPS = [
  'opened',
  'service',
  'time',
  'cal_calendar',
  'cal_time',
  'cal_details',
  'contact',
  'review',
  'details_submitted',
  'pay_choice',
  'pay',
  'checkout',
  'payment_attempt',
  'confirmed',
] as const;
export type BookingAttemptStep = (typeof BOOKING_ATTEMPT_STEPS)[number];

export const CHECKOUT_METHODS = ['apple_pay', 'card', 'google_pay', 'link'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

const CHECKOUT_METHOD_SET = new Set<string>(CHECKOUT_METHODS);

const STEP_SET = new Set<string>(BOOKING_ATTEMPT_STEPS);
const ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Quiet, unconfirmed attempts count as abandoned after this long. */
export const BOOKING_ATTEMPT_ABANDON_MS = 30 * 60 * 1000;

export function parseAttemptId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return ATTEMPT_ID_RE.test(id) ? id : null;
}

export function parseAttemptSurface(value: unknown): BookingAttemptSurface | null {
  if (value === 'phone' || value === 'desktop') return value;
  return null;
}

export function parseAttemptStep(value: unknown): BookingAttemptStep | null {
  if (typeof value !== 'string') return null;
  const step = value.trim();
  return STEP_SET.has(step) ? (step as BookingAttemptStep) : null;
}

/** Display-safe service label. Drops anything that looks like an email. */
export function cleanAttemptService(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().slice(0, 120);
  if (!cleaned || cleaned.includes('@')) return null;
  return cleaned;
}

export function parseCheckoutMethod(value: unknown): CheckoutMethod | null {
  if (typeof value !== 'string') return null;
  const method = value.trim();
  return CHECKOUT_METHOD_SET.has(method) ? (method as CheckoutMethod) : null;
}

/** Stripe wallet type, or the express button they confirmed. Anything else is a typed card. */
export function checkoutMethodFromWallet(type: string | null | undefined): CheckoutMethod {
  if (type === 'apple_pay' || type === 'google_pay' || type === 'link') return type;
  return 'card';
}

export function calRouteToAttemptStep(route: string): BookingAttemptStep | null {
  if (route === 'calendar') return 'cal_calendar';
  if (route === 'time') return 'cal_time';
  if (route === 'details') return 'cal_details';
  return null;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Later steps outrank earlier ones. Reopening a service must not rewind progress. */
function stepRank(step: string): number {
  switch (step) {
    case 'opened':
      return 0;
    case 'service':
    case 'cal_calendar':
      return 1;
    case 'time':
    case 'cal_time':
      return 2;
    case 'contact':
    case 'cal_details':
    case 'details_submitted':
      return 3;
    case 'review':
      return 4;
    case 'pay_choice':
    case 'pay':
    case 'checkout':
      return 5;
    case 'payment_attempt':
      return 6;
    case 'confirmed':
      return 7;
    default:
      return 0;
  }
}

/**
 * Upsert one step. Same step again only refreshes last_seen_at.
 * A return after close clears left_at. An earlier step does not rewind
 * last_step. Completed rows stay completed.
 */
export async function recordBookingAttempt(input: {
  attemptId: string;
  surface: BookingAttemptSurface;
  step: BookingAttemptStep;
  service?: string | null;
  checkoutMethod?: CheckoutMethod | null;
}): Promise<void> {
  const at = isoNow();
  const service = input.service ?? null;
  const checkoutMethod = input.checkoutMethod ?? null;
  const rank = stepRank(input.step);
  const firstStep = JSON.stringify([{ step: input.step, at }]);
  const appended = JSON.stringify([{ step: input.step, at }]);
  await sql`
    INSERT INTO booking_attempts (
      id, surface, service_label, last_step, steps, checkout_method
    )
    VALUES (
      ${input.attemptId},
      ${input.surface},
      ${service},
      ${input.step},
      ${firstStep}::jsonb,
      ${checkoutMethod}
    )
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = NOW(),
      left_at = CASE
        WHEN booking_attempts.completed_at IS NULL THEN NULL
        ELSE booking_attempts.left_at
      END,
      service_label = COALESCE(${service}, booking_attempts.service_label),
      checkout_method = CASE
        WHEN ${checkoutMethod}::text IS NULL THEN booking_attempts.checkout_method
        WHEN booking_attempts.completed_at IS NOT NULL THEN booking_attempts.checkout_method
        ELSE ${checkoutMethod}
      END,
      last_step = CASE
        WHEN booking_attempts.completed_at IS NOT NULL THEN booking_attempts.last_step
        WHEN ${rank} < CASE booking_attempts.last_step
          WHEN 'opened' THEN 0
          WHEN 'service' THEN 1
          WHEN 'cal_calendar' THEN 1
          WHEN 'time' THEN 2
          WHEN 'cal_time' THEN 2
          WHEN 'contact' THEN 3
          WHEN 'cal_details' THEN 3
          WHEN 'details_submitted' THEN 3
          WHEN 'review' THEN 4
          WHEN 'pay_choice' THEN 5
          WHEN 'pay' THEN 5
          WHEN 'checkout' THEN 5
          WHEN 'payment_attempt' THEN 6
          WHEN 'confirmed' THEN 7
          ELSE 0
        END THEN booking_attempts.last_step
        ELSE ${input.step}
      END,
      steps = CASE
        WHEN booking_attempts.completed_at IS NOT NULL THEN booking_attempts.steps
        WHEN booking_attempts.last_step = ${input.step} THEN booking_attempts.steps
        WHEN ${rank} < CASE booking_attempts.last_step
          WHEN 'opened' THEN 0
          WHEN 'service' THEN 1
          WHEN 'cal_calendar' THEN 1
          WHEN 'time' THEN 2
          WHEN 'cal_time' THEN 2
          WHEN 'contact' THEN 3
          WHEN 'cal_details' THEN 3
          WHEN 'details_submitted' THEN 3
          WHEN 'review' THEN 4
          WHEN 'pay_choice' THEN 5
          WHEN 'pay' THEN 5
          WHEN 'checkout' THEN 5
          WHEN 'payment_attempt' THEN 6
          WHEN 'confirmed' THEN 7
          ELSE 0
        END THEN booking_attempts.steps
        ELSE booking_attempts.steps || ${appended}::jsonb
      END
  `;
}

/** Tab closed or the booker was dismissed. Does not change the last step. */
export async function leaveBookingAttempt(attemptId: string): Promise<void> {
  await sql`
    UPDATE booking_attempts
    SET left_at = NOW(),
        last_seen_at = NOW()
    WHERE id = ${attemptId}
      AND completed_at IS NULL
  `;
}

/** After a hold row exists, attach it. Failures must not block checkout. */
export async function linkBookingAttempt(
  attemptId: string | null,
  calBookingUid: string
): Promise<void> {
  if (!attemptId || !calBookingUid) return;
  try {
    await sql`
      UPDATE booking_attempts AS attempt
      SET appointment_id = appt.id,
          service_label = COALESCE(attempt.service_label, appt.service_name)
      FROM appointments AS appt
      WHERE attempt.id = ${attemptId}
        AND appt.cal_event_id = ${calBookingUid}
        AND attempt.appointment_id IS NULL
    `;
  } catch (err) {
    console.warn('[booking-attempt] link failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Payment succeeded on /api/booking/confirm (card or Apple Pay).
 * Failures must not block the confirm response.
 */
export async function completeBookingAttempt(
  calBookingUid: string,
  checkoutMethod?: CheckoutMethod | null
): Promise<void> {
  if (!calBookingUid) return;
  const method = checkoutMethod ?? null;
  try {
    const confirmedStep = JSON.stringify([
      { step: 'confirmed', at: new Date().toISOString() },
    ]);
    await sql`
      UPDATE booking_attempts AS attempt
      SET completed_at = COALESCE(attempt.completed_at, NOW()),
          left_at = NULL,
          last_seen_at = NOW(),
          last_step = 'confirmed',
          checkout_method = CASE
            WHEN ${method}::text IS NOT NULL THEN ${method}
            ELSE attempt.checkout_method
          END,
          steps = CASE
            WHEN attempt.last_step = 'confirmed' THEN attempt.steps
            ELSE attempt.steps || ${confirmedStep}::jsonb
          END
      FROM appointments AS appt
      WHERE attempt.appointment_id = appt.id
        AND appt.cal_event_id = ${calBookingUid}
        AND (
          attempt.completed_at IS NULL
          OR ${method}::text IS NOT NULL
        )
    `;
  } catch (err) {
    console.warn('[booking-attempt] complete failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
