/**
 * Public booking-attempt sessions for /admin/funnel.
 *
 * A start is opening /book (phone) or a service drawer (desktop).
 * Steps are appended only when they change. Closing the tab sets left_at.
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

export function calRouteToAttemptStep(route: string): BookingAttemptStep | null {
  if (route === 'calendar') return 'cal_calendar';
  if (route === 'time') return 'cal_time';
  if (route === 'details') return 'cal_details';
  return null;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Upsert one step. Same step again only refreshes last_seen_at.
 * A return after close clears left_at. Completed rows stay completed.
 */
export async function recordBookingAttempt(input: {
  attemptId: string;
  surface: BookingAttemptSurface;
  step: BookingAttemptStep;
  service?: string | null;
}): Promise<void> {
  const at = isoNow();
  const service = input.service ?? null;
  const firstStep = JSON.stringify([{ step: input.step, at }]);
  const appended = JSON.stringify([{ step: input.step, at }]);
  await sql`
    INSERT INTO booking_attempts (
      id, surface, service_label, last_step, steps
    )
    VALUES (
      ${input.attemptId},
      ${input.surface},
      ${service},
      ${input.step},
      ${firstStep}::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = NOW(),
      left_at = CASE
        WHEN booking_attempts.completed_at IS NULL THEN NULL
        ELSE booking_attempts.left_at
      END,
      service_label = COALESCE(${service}, booking_attempts.service_label),
      last_step = CASE
        WHEN booking_attempts.completed_at IS NOT NULL THEN booking_attempts.last_step
        ELSE ${input.step}
      END,
      steps = CASE
        WHEN booking_attempts.completed_at IS NOT NULL THEN booking_attempts.steps
        WHEN booking_attempts.last_step = ${input.step} THEN booking_attempts.steps
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
export async function completeBookingAttempt(calBookingUid: string): Promise<void> {
  if (!calBookingUid) return;
  try {
    const confirmedStep = JSON.stringify([
      { step: 'confirmed', at: new Date().toISOString() },
    ]);
    await sql`
      UPDATE booking_attempts AS attempt
      SET completed_at = NOW(),
          left_at = NULL,
          last_seen_at = NOW(),
          last_step = 'confirmed',
          steps = CASE
            WHEN attempt.last_step = 'confirmed' THEN attempt.steps
            ELSE attempt.steps || ${confirmedStep}::jsonb
          END
      FROM appointments AS appt
      WHERE attempt.appointment_id = appt.id
        AND appt.cal_event_id = ${calBookingUid}
        AND attempt.completed_at IS NULL
    `;
  } catch (err) {
    console.warn('[booking-attempt] complete failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
