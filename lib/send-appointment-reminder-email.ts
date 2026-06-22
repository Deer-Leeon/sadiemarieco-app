import { sql } from '@vercel/postgres';
import { Resend } from 'resend';

import {
  buildReminderBodyCopy,
  reminderEmailSubject,
  type ReminderEmailTiming,
} from '@/lib/appointment-reminder-copy';
import {
  inferReminderKindFromServiceName,
  resolveAppointmentService,
  type ReminderServiceKind,
} from '@/lib/appointment-service-lookup';
import { generateReminderHtml } from '@/lib/email-templates';
import {
  formatBookingStartParts,
} from '@/lib/send-booking-confirmation-email';

const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || 'Sadie Marie <bookings@sadiemarie.co>';

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';
const MANAGE_LINK_BASE = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/manage.html`;

function maskEmail(email: string): string {
  if (!email.includes('@')) return '[redacted]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function normaliseBookingTimeIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function bookingTimesMatch(
  stored: string | Date | null | undefined,
  expected: string,
): boolean {
  if (!stored) return false;
  const storedMs = new Date(stored).getTime();
  const expectedMs = new Date(expected).getTime();
  if (!Number.isFinite(storedMs) || !Number.isFinite(expectedMs)) {
    return String(stored) === expected;
  }
  return Math.abs(storedMs - expectedMs) < 1000;
}

async function claimReminderEmailSend(idempotencyKey: string): Promise<boolean> {
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${idempotencyKey})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[appointment-reminder-email] idempotency claim failed', {
      idempotencyKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export async function sendAppointmentReminderEmail(args: {
  bookingUid: string;
  clientEmail: string;
  clientName?: string | null;
  serviceName: string;
  bookingTime: string;
  endTime?: string | null;
  reminderKind: ReminderServiceKind;
  timing: ReminderEmailTiming;
  minutesUntil?: number;
  expectedBookingTime?: string;
}): Promise<{ ok: boolean; skipped?: string; error?: string; id?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[appointment-reminder-email] RESEND_API_KEY is not configured');
    return { ok: false, skipped: 'email_not_configured' };
  }

  const clientEmail = args.clientEmail.trim().toLowerCase();
  if (!clientEmail || !clientEmail.includes('@')) {
    return { ok: false, skipped: 'no_email' };
  }

  const expectedBookingTime = normaliseBookingTimeIso(
    args.expectedBookingTime ?? args.bookingTime,
  );
  const idempotencyKey = `${args.bookingUid}:${expectedBookingTime}:email:${args.timing}`;

  const claimed = await claimReminderEmailSend(idempotencyKey);
  if (!claimed) {
    console.log('[appointment-reminder-email] duplicate skipped', {
      bookingUid: args.bookingUid,
      timing: args.timing,
    });
    return { ok: true, skipped: 'already_sent' };
  }

  const resolved = await resolveAppointmentService(
    args.serviceName,
    args.bookingTime,
    args.endTime,
  );
  const displayName = resolved.displayName || args.serviceName;
  const kind = args.reminderKind;

  const bodyCopy = buildReminderBodyCopy({
    serviceName: displayName,
    kind,
    timing: args.timing,
    minutesUntil: args.minutesUntil,
  });

  const { date, time } = formatBookingStartParts(args.bookingTime);
  const cancelUrl = `${MANAGE_LINK_BASE}?uid=${encodeURIComponent(args.bookingUid)}`;
  const html = generateReminderHtml({
    serviceName: displayName,
    appointmentDate: date,
    appointmentTime: time,
    bodyCopy,
    cancelUrl,
  });

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: clientEmail,
    subject: reminderEmailSubject(displayName),
    html,
  });

  if (error) {
    console.error('[appointment-reminder-email] Resend send failed', {
      bookingUid: args.bookingUid,
      timing: args.timing,
      to: maskEmail(clientEmail),
      error,
    });
    return { ok: false, error: error.message };
  }

  console.log('[appointment-reminder-email] sent', {
    bookingUid: args.bookingUid,
    timing: args.timing,
    to: maskEmail(clientEmail),
    id: data?.id,
  });

  return { ok: true, id: data?.id };
}

export interface AppointmentReminderRow {
  cal_event_id: string;
  status: string | null;
  service_name: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  client_email: string | null;
  client_first_name: string | null;
}

export async function deliverScheduledReminderEmail(args: {
  bookingUid: string;
  expectedBookingTime: string;
  timing: 'lead' | '1h';
}): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const { rows } = await sql<AppointmentReminderRow>`
    SELECT
      cal_event_id,
      status,
      service_name,
      booking_time,
      end_time,
      client_email,
      client_first_name
    FROM appointments
    WHERE cal_event_id = ${args.bookingUid}
    LIMIT 1
  `;

  const appointment = rows[0];
  if (!appointment) {
    return { ok: true, skipped: 'not_found' };
  }

  if (appointment.status && appointment.status !== 'confirmed') {
    return { ok: true, skipped: 'status_not_confirmed' };
  }

  if (!bookingTimesMatch(appointment.booking_time, args.expectedBookingTime)) {
    return { ok: true, skipped: 'booking_time_changed' };
  }

  const clientEmail = appointment.client_email?.trim();
  if (!clientEmail) {
    return { ok: true, skipped: 'no_email' };
  }

  const bookingTimeIso = normaliseBookingTimeIso(
    appointment.booking_time instanceof Date
      ? appointment.booking_time.toISOString()
      : String(appointment.booking_time),
  );

  const resolved = await resolveAppointmentService(
    appointment.service_name || '',
    bookingTimeIso,
    appointment.end_time,
  );

  if (args.timing === 'lead' && !resolved.reminderKind) {
    return { ok: true, skipped: 'unknown_service_category' };
  }

  const kind =
    resolved.reminderKind ??
    inferReminderKindFromServiceName(appointment.service_name || '');
  if (!kind) {
    return { ok: true, skipped: 'unknown_service_category' };
  }

  const result = await sendAppointmentReminderEmail({
    bookingUid: args.bookingUid,
    clientEmail,
    clientName: appointment.client_first_name,
    serviceName: appointment.service_name || '',
    bookingTime: bookingTimeIso,
    endTime:
      appointment.end_time instanceof Date
        ? appointment.end_time.toISOString()
        : appointment.end_time,
    reminderKind: kind,
    timing: args.timing,
    expectedBookingTime: args.expectedBookingTime,
  });

  return result;
}

export { bookingTimesMatch, normaliseBookingTimeIso };
