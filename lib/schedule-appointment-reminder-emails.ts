import {
  createQStashClient,
} from '@/lib/qstash-client';
import {
  inferReminderKindFromServiceName,
  resolveAppointmentService,
  type ReminderServiceKind,
} from '@/lib/appointment-service-lookup';
import {
  normaliseBookingTimeIso,
  sendAppointmentReminderEmail,
} from '@/lib/send-appointment-reminder-email';

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

const HOUR_MS = 60 * 60 * 1000;
const LEAD_OFFSET_MS: Record<ReminderServiceKind, number> = {
  brows: 48 * HOUR_MS,
  lashes: 24 * HOUR_MS,
};

export interface ScheduleReminderEmailsArgs {
  bookingUid: string;
  bookingTime: string;
  serviceName: string;
  clientEmail?: string | null;
  endTime?: string | null;
}

export interface ScheduleReminderEmailsResult {
  scheduled: boolean;
  reason?: string;
  lead?: unknown;
  oneHour?: unknown;
  immediateOneHour?: unknown;
}

async function publishReminderJob(args: {
  bookingUid: string;
  expectedBookingTime: string;
  timing: 'lead' | '1h';
  notBefore: number;
}): Promise<unknown> {
  const qstash = createQStashClient();
  if (!qstash) {
    throw new Error('qstash_not_configured');
  }
  const res = await qstash.publishJSON({
    url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/remind-email`,
    body: {
      bookingUid: args.bookingUid,
      expectedBookingTime: args.expectedBookingTime,
      timing: args.timing,
    },
    notBefore: args.notBefore,
  });
  return res?.messageId ?? true;
}

/**
 * Queue (or immediately send) pre-appointment reminder emails.
 * Lead timing: 48h for brows, 24h for lashes — skipped when booked inside
 * that window. One-hour reminder is always attempted; sends immediately with
 * dynamic copy when the appointment is less than an hour away.
 */
export async function scheduleAppointmentReminderEmails(
  args: ScheduleReminderEmailsArgs,
): Promise<ScheduleReminderEmailsResult> {
  const appointmentMs = new Date(args.bookingTime).getTime();
  if (!Number.isFinite(appointmentMs)) {
    return { scheduled: false, reason: 'invalid_booking_time' };
  }

  const nowMs = Date.now();
  const msUntilAppt = appointmentMs - nowMs;
  if (msUntilAppt <= 0) {
    return { scheduled: false, reason: 'appointment_in_past' };
  }

  const expectedBookingTime = normaliseBookingTimeIso(args.bookingTime);
  const resolved = await resolveAppointmentService(
    args.serviceName,
    args.bookingTime,
    args.endTime,
  );

  const out: ScheduleReminderEmailsResult = { scheduled: true };
  const reminderKind =
    resolved.reminderKind ??
    inferReminderKindFromServiceName(args.serviceName);

  if (process.env.QSTASH_TOKEN) {
    if (resolved.reminderKind) {
      const leadOffset = LEAD_OFFSET_MS[resolved.reminderKind];
      if (msUntilAppt >= leadOffset) {
        const notBefore = Math.floor((appointmentMs - leadOffset) / 1000);
        try {
          out.lead = await publishReminderJob({
            bookingUid: args.bookingUid,
            expectedBookingTime,
            timing: 'lead',
            notBefore,
          });
        } catch (err) {
          console.error('[schedule-reminder-emails] lead queue failed', {
            bookingUid: args.bookingUid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (msUntilAppt >= HOUR_MS && reminderKind) {
      const notBefore = Math.floor((appointmentMs - HOUR_MS) / 1000);
      try {
        out.oneHour = await publishReminderJob({
          bookingUid: args.bookingUid,
          expectedBookingTime,
          timing: '1h',
          notBefore,
        });
      } catch (err) {
        console.error('[schedule-reminder-emails] 1h queue failed', {
          bookingUid: args.bookingUid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (args.clientEmail?.trim() && reminderKind) {
      const minutesUntil = Math.max(1, Math.round(msUntilAppt / 60_000));
      try {
        out.immediateOneHour = await sendAppointmentReminderEmail({
          bookingUid: args.bookingUid,
          clientEmail: args.clientEmail.trim(),
          serviceName: args.serviceName,
          bookingTime: expectedBookingTime,
          endTime: args.endTime,
          reminderKind,
          timing: 'immediate',
          minutesUntil,
          expectedBookingTime,
        });
      } catch (err) {
        console.error('[schedule-reminder-emails] immediate 1h send failed', {
          bookingUid: args.bookingUid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    out.scheduled = false;
    out.reason = 'qstash_not_configured';
  }

  return out;
}
