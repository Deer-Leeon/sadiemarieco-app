/**
 * POST /api/admin/appointments/[id]/admin-reschedule
 *
 * Admin god-mode reschedule: pick any slot (same as manual booking),
 * create the new Cal booking with allowConflicts / out-of-bounds, cancel
 * the old Cal booking, then update the local appointments row in place.
 *
 * Body: { start: string, eventTypeId: number }
 *   • start — studio-local wall time `YYYY-MM-DDTHH:mm:ss` (or ISO)
 *   • eventTypeId — real service Cal event type id
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  isSameAppointmentSlot,
  RESCHEDULE_SAME_SLOT_MESSAGE,
} from '@/lib/appointment-slot';
import { bookingEndFromDurationMins } from '@/lib/booking-duration';
import {
  notifyAppointmentRescheduled,
  rescheduleAppointmentReminderEmails,
} from '@/lib/booking-notifications';
import {
  CAL_STUDIO_IN_PERSON_LOCATION,
  getCalComApiKey,
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import {
  CalStartTimeError,
  parseBookingStartForCal,
} from '@/lib/cal-timezone';
import {
  CAL_BOOKINGS_ADMIN_CREATE_API_VERSION,
  CAL_BOOKINGS_API_VERSION,
  CAL_V2_BASE,
  confirmCalV2Booking,
  proxyCalV2Post,
} from '@/lib/cal-proxy';
import {
  calAttendeeEmailForBooking,
  clientPhoneValidationMessage,
  parseClientPhone,
  parseOptionalClientEmail,
} from '@/lib/client-identity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_RESCHEDULE_CANCEL_REASON = 'Rescheduled by admin';

interface Context {
  params: Promise<{ id: string }>;
}

interface Body {
  start?: unknown;
  eventTypeId?: unknown;
}

interface AppointmentRow {
  id: string | number;
  cal_event_id: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  status: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  service_name: string | null;
  sms_opt_in: boolean | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseIntegerId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function serialiseDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function studioBookingLocation(): Record<string, unknown> {
  return {
    type: CAL_STUDIO_IN_PERSON_LOCATION.type,
    address: CAL_STUDIO_IN_PERSON_LOCATION.address,
  };
}

function extractBooking(payload: unknown): {
  uid: string | null;
  status: string | null;
  startTime: string | null;
  endTime: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return { uid: null, status: null, startTime: null, endTime: null };
  }
  const root = payload as Record<string, unknown>;
  const booking =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root.booking && typeof root.booking === 'object'
        ? (root.booking as Record<string, unknown>)
        : root;
  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  return {
    uid: asString(booking.uid),
    status: asString(booking.status),
    startTime: asString(booking.startTime) ?? asString(booking.start),
    endTime: asString(booking.endTime) ?? asString(booking.end),
  };
}

function isScheduleOrBoundsError(status: number, message: string): boolean {
  if (status === 409) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes('not available') ||
    lower.includes('no available') ||
    lower.includes('out of bounds') ||
    lower.includes('outside') ||
    lower.includes('schedule') ||
    lower.includes('working hours')
  );
}

async function cancelOnCal(uid: string): Promise<string | null> {
  const apiKey = getCalComApiKey();
  if (!apiKey) {
    return 'Cal.com API key is not configured';
  }
  try {
    const upstream = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(uid)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_BOOKINGS_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          cancellationReason: ADMIN_RESCHEDULE_CANCEL_REASON,
        }),
      }
    );
    if (upstream.status === 404) return null;
    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => null);
      const message =
        payload &&
        typeof payload === 'object' &&
        'message' in payload &&
        typeof (payload as { message: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `HTTP ${upstream.status}`;
      return `Cal.com rejected the cancel (${message})`;
    }
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

async function loadAppointment(idParam: string): Promise<AppointmentRow | null> {
  const intId = parseIntegerId(idParam);
  if (UUID_RE.test(idParam)) {
    const { rows } = await sql<AppointmentRow>`
      SELECT id, cal_event_id, booking_time, end_time, status,
             client_first_name, client_last_name, client_phone, client_email,
             service_name, sms_opt_in
      FROM appointments
      WHERE id = ${idParam}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  if (intId !== null) {
    const { rows } = await sql<AppointmentRow>`
      SELECT id, cal_event_id, booking_time, end_time, status,
             client_first_name, client_last_name, client_phone, client_email,
             service_name, sms_opt_in
      FROM appointments
      WHERE id = ${intId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id: idParam } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const body = raw as Body;
  const startRaw = typeof body.start === 'string' ? body.start.trim() : '';
  const eventTypeId =
    typeof body.eventTypeId === 'number'
      ? body.eventTypeId
      : typeof body.eventTypeId === 'string'
        ? Number(body.eventTypeId)
        : NaN;

  if (!startRaw) {
    return NextResponse.json(
      { error: 'invalid_start', message: 'start is required' },
      { status: 400 }
    );
  }
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return NextResponse.json(
      {
        error: 'invalid_event_type_id',
        message: 'eventTypeId must be a positive integer',
      },
      { status: 400 }
    );
  }

  let startUtc: Date;
  try {
    startUtc = parseBookingStartForCal(startRaw);
  } catch (err) {
    const message =
      err instanceof CalStartTimeError ? err.message : 'Invalid start time';
    return NextResponse.json(
      { error: 'invalid_start', message },
      { status: 400 }
    );
  }

  try {
    const existing = await loadAppointment(idParam);
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const service = await loadServiceByCalEventId(eventTypeId);
    if (!service) {
      return NextResponse.json(
        {
          error: 'service_not_found',
          message: `No active bookable service for Cal event type ${eventTypeId}`,
        },
        { status: 404 }
      );
    }

    const proposedEndIso = bookingEndFromDurationMins(
      startUtc.toISOString(),
      service.duration_mins
    );

    if (
      isSameAppointmentSlot(
        existing.booking_time,
        existing.end_time,
        startUtc.toISOString(),
        proposedEndIso
      )
    ) {
      return NextResponse.json(
        {
          error: 'same_slot',
          message: RESCHEDULE_SAME_SLOT_MESSAGE,
        },
        { status: 400 }
      );
    }

    const firstName = (existing.client_first_name || '').trim() || 'Client';
    const lastName = (existing.client_last_name || '').trim() || 'Guest';
    const clientName = [firstName, lastName].filter(Boolean).join(' ');
    const parsedPhone = parseClientPhone(existing.client_phone);
    if (!parsedPhone) {
      return NextResponse.json(
        {
          error: 'invalid_client_phone',
          message: clientPhoneValidationMessage(),
        },
        { status: 400 }
      );
    }
    const clientEmail = parseOptionalClientEmail(existing.client_email);

    const overrideEventTypeId = parseAdminOverrideEventId();
    const calPayload: Record<string, unknown> = {
      eventTypeId,
      start: startUtc.toISOString(),
      attendee: {
        name: clientName,
        email: calAttendeeEmailForBooking(parsedPhone.digits, clientEmail),
        phoneNumber: parsedPhone.e164,
        timeZone: STUDIO_TIMEZONE,
      },
      bookingFieldsResponses: {
        name: {
          firstName,
          lastName,
        },
        attendeePhoneNumber: parsedPhone.e164,
      },
      location: studioBookingLocation(),
      metadata: {
        manual_admin_booking: 'true',
        admin_reschedule: 'true',
        original_service_name: service.title,
        original_service_duration_mins: String(service.duration_mins),
      },
    };

    if (overrideEventTypeId != null) {
      calPayload.allowConflicts = true;
      calPayload.allowBookingOutOfBounds = true;
    }

    let createApiVersion = CAL_BOOKINGS_API_VERSION;
    if (overrideEventTypeId != null) {
      createApiVersion = CAL_BOOKINGS_ADMIN_CREATE_API_VERSION;
    }

    let result = await proxyCalV2Post(
      '/bookings',
      calPayload,
      createApiVersion
    );

    if (
      !result.ok &&
      overrideEventTypeId != null &&
      result.response.status < 500
    ) {
      const fallbackBody = await result.response.clone().json().catch(() => null);
      const fallbackMessage =
        fallbackBody &&
        typeof fallbackBody === 'object' &&
        'message' in fallbackBody &&
        typeof (fallbackBody as { message: unknown }).message === 'string'
          ? (fallbackBody as { message: string }).message
          : '';

      if (isScheduleOrBoundsError(result.response.status, fallbackMessage)) {
        const shadowPayload: Record<string, unknown> = {
          ...calPayload,
          eventTypeId: overrideEventTypeId,
        };
        delete shadowPayload.allowConflicts;
        delete shadowPayload.allowBookingOutOfBounds;
        shadowPayload.lengthInMinutes = service.duration_mins;

        result = await proxyCalV2Post(
          '/bookings',
          shadowPayload,
          CAL_BOOKINGS_API_VERSION
        );
      }
    }

    if (!result.ok) return result.response;

    const created = extractBooking(result.data);
    if (!created.uid) {
      return NextResponse.json(
        {
          error: 'missing_cal_uid',
          message: 'Cal.com did not return a booking reference',
        },
        { status: 502 }
      );
    }

    if (created.status && created.status.toUpperCase() !== 'ACCEPTED') {
      const confirmError = await confirmCalV2Booking(created.uid);
      if (confirmError) {
        console.warn(
          '[api/admin/appointments/admin-reschedule] confirm follow-up failed',
          { uid: created.uid, confirmError }
        );
      }
    }

    const newBookingTime = created.startTime ?? startUtc.toISOString();
    const newEndTime =
      created.endTime ??
      bookingEndFromDurationMins(newBookingTime, service.duration_mins);

    let calCancelError: string | null = null;
    const oldUid = existing.cal_event_id?.trim() || null;
    if (oldUid && oldUid !== created.uid) {
      calCancelError = await cancelOnCal(oldUid);
    }

    const newEndTimeSql = newEndTime ?? null;
    const idAsString = String(existing.id);
    const isUuid = UUID_RE.test(idAsString);
    const intId = parseIntegerId(idAsString);

    let rows: AppointmentRow[] = [];
    if (isUuid) {
      ({ rows } = await sql<AppointmentRow>`
        UPDATE appointments
        SET cal_event_id = ${created.uid},
            booking_time = ${newBookingTime},
            end_time     = ${newEndTimeSql},
            status       = 'confirmed'
        WHERE id = ${idAsString}::uuid
        RETURNING id, cal_event_id, booking_time, end_time, status,
                  client_first_name, client_last_name, client_phone, client_email,
                  service_name, sms_opt_in
      `);
    } else if (intId !== null) {
      ({ rows } = await sql<AppointmentRow>`
        UPDATE appointments
        SET cal_event_id = ${created.uid},
            booking_time = ${newBookingTime},
            end_time     = ${newEndTimeSql},
            status       = 'confirmed'
        WHERE id = ${intId}
        RETURNING id, cal_event_id, booking_time, end_time, status,
                  client_first_name, client_last_name, client_phone, client_email,
                  service_name, sms_opt_in
      `);
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: 'update_failed' }, { status: 500 });
    }

    const row = rows[0];
    const reminderEmails = await rescheduleAppointmentReminderEmails(
      row.cal_event_id || created.uid
    );

    const bookingTimeIso = serialiseDate(row.booking_time);
    let rescheduleSms: Record<string, unknown> | null = null;
    try {
      rescheduleSms = await notifyAppointmentRescheduled({
        bookingUid: row.cal_event_id || created.uid,
        bookingTime: bookingTimeIso,
        clientPhone: row.client_phone,
        serviceName: row.service_name,
        smsOptIn: row.sms_opt_in,
        scheduleSmsReminders: true,
      });
    } catch (smsErr) {
      console.warn(
        '[api/admin/appointments/admin-reschedule] SMS failed (non-blocking)',
        { error: errorMessage(smsErr) }
      );
    }

    return NextResponse.json({
      appointment: {
        id: row.id,
        cal_uid: row.cal_event_id,
        booking_time: bookingTimeIso,
        end_time: serialiseDate(row.end_time),
        status: row.status,
      },
      reminderEmails,
      rescheduleSms,
      cal_cancel_error: calCancelError,
    });
  } catch (err) {
    console.error('[api/admin/appointments/admin-reschedule] failed', err);
    return NextResponse.json(
      { error: 'reschedule_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
