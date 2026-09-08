import {
  createQStashClient,
} from '@/lib/qstash-client';
import {
  resolveAppointmentService,
} from '@/lib/appointment-service-lookup';
import {
  normaliseBookingTimeIso,
} from '@/lib/send-appointment-reminder-email';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const visitSms = require('./same-day-visit.js') as {
  loadVisitForBookingUid: (
    uid: string,
  ) => Promise<{
    canonicalUid: string | null;
    arrivalTime: string | null;
    leadKind: '48h' | '24h';
    leadOffsetMs: number;
    services: unknown[];
    fingerprint: string;
  } | null>;
};

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

const HOUR_MS = 60 * 60 * 1000;
const LEAD_OFFSET_MS = {
  brows: 48 * HOUR_MS,
  lashes: 24 * HOUR_MS,
} as const;

export interface ScheduleReminderEmailsArgs {
  bookingUid: string;
  bookingTime: string;
  serviceName: string;
  clientEmail?: string | null;
  endTime?: string | null;
  calEventTypeId?: number | null;
}

export interface ScheduleReminderEmailsResult {
  scheduled: boolean;
  reason?: string;
  lead?: unknown;
}

async function publishReminderJob(args: {
  bookingUid: string;
  expectedBookingTime: string;
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
      timing: 'lead',
    },
    notBefore: args.notBefore,
  });
  return res?.messageId ?? true;
}

/**
 * Queue pre-appointment reminder emails.
 * Lead timing: 48h for brows, 24h for lashes. If the visit is already
 * inside that window (including the last 90 minutes), send immediately.
 * There is no 1-hour reminder email.
 */
export async function scheduleAppointmentReminderEmails(
  args: ScheduleReminderEmailsArgs,
): Promise<ScheduleReminderEmailsResult> {
  let appointmentMs = new Date(args.bookingTime).getTime();
  if (!Number.isFinite(appointmentMs)) {
    return { scheduled: false, reason: 'invalid_booking_time' };
  }

  let bookingUid = args.bookingUid;
  let leadOffset = LEAD_OFFSET_MS.lashes;
  let expectedBookingTime = normaliseBookingTimeIso(args.bookingTime);

  let usedVisit = false;
  try {
    const visit = await visitSms.loadVisitForBookingUid(args.bookingUid);
    if (visit?.services?.length && visit.arrivalTime && visit.canonicalUid) {
      bookingUid = visit.canonicalUid;
      appointmentMs = new Date(visit.arrivalTime).getTime();
      expectedBookingTime = normaliseBookingTimeIso(visit.arrivalTime);
      leadOffset =
        visit.leadKind === '48h' ? LEAD_OFFSET_MS.brows : LEAD_OFFSET_MS.lashes;
      usedVisit = true;
    }
  } catch (err) {
    console.warn('[schedule-reminder-emails] visit lookup failed', {
      bookingUid: args.bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const msUntilAppt = appointmentMs - nowMs;
  if (msUntilAppt <= 0) {
    return { scheduled: false, reason: 'appointment_in_past' };
  }

  const resolved = await resolveAppointmentService(
    args.serviceName,
    args.bookingTime,
    args.endTime,
    args.calEventTypeId,
  );

  const out: ScheduleReminderEmailsResult = { scheduled: true };

  if (process.env.QSTASH_TOKEN) {
    if (usedVisit || resolved.reminderKind) {
      if (!usedVisit && resolved.reminderKind) {
        leadOffset = LEAD_OFFSET_MS[resolved.reminderKind];
      }
      const notBefore =
        msUntilAppt >= leadOffset
          ? Math.floor((appointmentMs - leadOffset) / 1000)
          : nowSec + 2;
      try {
        out.lead = await publishReminderJob({
          bookingUid,
          expectedBookingTime,
          notBefore,
        });
      } catch (err) {
        console.error('[schedule-reminder-emails] lead queue failed', {
          bookingUid,
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
