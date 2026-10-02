/**
 * POST /api/admin/appointments/[id]/change-service
 *
 * Swap an unpaid upcoming visit to a different catalogue service.
 * The start time stays. Price, colour, and end time follow the new
 * service; attached extras keep their link and move with the new length.
 * A longer visit may overlap another appointment or a blocked time,
 * the same way an admin manual booking can double-book.
 *
 * Body: { eventTypeId: number, send_sms?: boolean }
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { syncAttachedExtrasTimes } from '@/lib/appointment-attached';
import { parseSendSmsFromBody } from '@/lib/admin-send-sms-flag';
import {
  notifyAppointmentServiceChanged,
  rescheduleAppointmentReminderEmails,
} from '@/lib/booking-notifications';
import {
  displayedChairDurationMins,
  endIsoFromDuration,
  snapChairDurationMins,
} from '@/lib/chair-duration';
import {
  CAL_STUDIO_IN_PERSON_LOCATION,
  getCalComApiKey,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
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
import {
  ensureChairDurationSchema,
  loadCatalogueDurationMins,
} from '@/lib/visit-duration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICE_CHANGE_CANCEL_REASON = 'Service changed by admin';

interface Context {
  params: Promise<{ id: string }>;
}

interface Body {
  eventTypeId?: unknown;
  send_sms?: unknown;
  sendSms?: unknown;
}

interface AppointmentRow {
  id: string | number;
  cal_event_id: string | null;
  cal_event_type_id: number | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  chair_duration_mins: number | null;
  status: string | null;
  attached_to_appointment_id: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  service_name: string | null;
  sms_opt_in: boolean | null;
  quoted_service_price_cents: number | null;
}

interface CatalogueService {
  title: string;
  duration_mins: number;
  price: number | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
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
          cancellationReason: SERVICE_CHANGE_CANCEL_REASON,
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
      SELECT id, cal_event_id, cal_event_type_id, booking_time, end_time,
             chair_duration_mins, status,
             attached_to_appointment_id::text AS attached_to_appointment_id,
             client_first_name, client_last_name, client_phone, client_email,
             service_name, sms_opt_in, quoted_service_price_cents
      FROM appointments
      WHERE id = ${idParam}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  if (intId !== null) {
    const { rows } = await sql<AppointmentRow>`
      SELECT id, cal_event_id, cal_event_type_id, booking_time, end_time,
             chair_duration_mins, status,
             attached_to_appointment_id::text AS attached_to_appointment_id,
             client_first_name, client_last_name, client_phone, client_email,
             service_name, sms_opt_in, quoted_service_price_cents
      FROM appointments
      WHERE id = ${intId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

async function loadCatalogueService(
  eventTypeId: number
): Promise<CatalogueService | null> {
  const { rows } = await sql<{
    title: string;
    duration_mins: number | null;
    price: number | null;
  }>`
    SELECT title, duration_mins, price::float8 AS price
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND cal_event_id = ${eventTypeId}
    ORDER BY display_order ASC, id ASC
    LIMIT 1
  `;
  const row = rows[0];
  const duration = row?.duration_mins == null ? NaN : Number(row.duration_mins);
  if (!row || !Number.isFinite(duration) || duration <= 0) return null;
  const price = row.price == null ? null : Number(row.price);
  return {
    title: row.title,
    duration_mins: duration,
    price: price != null && Number.isFinite(price) ? price : null,
  };
}

async function isSettled(appointmentId: string): Promise<boolean> {
  const { rows } = await sql<{ settled: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM appointment_payments
      WHERE appointment_id = ${appointmentId}
        AND status = 'succeeded'
    ) AS settled
  `;
  return Boolean(rows[0]?.settled);
}

async function attachedExtraMinutes(parentId: string): Promise<number> {
  const { rows } = await sql<{ extra_mins: number | null }>`
    SELECT COALESCE(SUM(s.duration_mins), 0)::int AS extra_mins
    FROM appointments a
    JOIN site_services s
      ON s.cal_event_id = a.cal_event_type_id
     AND s.is_active = TRUE
     AND s.is_group = FALSE
     AND s.duration_mins IS NOT NULL
     AND s.duration_mins > 0
    WHERE a.attached_to_appointment_id::text = ${parentId}
      AND LOWER(COALESCE(a.status, '')) NOT IN (
        'canceled_by_admin',
        'canceled_by_client',
        'canceled_by_client_late',
        'canceled_by_system',
        'cancelled',
        'no-show'
      )
  `;
  const mins = Number(rows[0]?.extra_mins ?? 0);
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}

async function clearWebhookDuplicate(
  newUid: string,
  ourId: string
): Promise<void> {
  await sql`
    DELETE FROM appointments other
    WHERE other.cal_event_id = ${newUid}
      AND other.id::text <> ${ourId}
      AND NOT EXISTS (
        SELECT 1
        FROM appointment_payments p
        WHERE p.appointment_id = other.id::text
          AND p.status = 'succeeded'
      )
  `;
}

export async function POST(
  req: NextRequest,
  context: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id: idParam } = await context.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const eventTypeId = Number(body.eventTypeId);
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return NextResponse.json(
      {
        error: 'invalid_event_type_id',
        message: 'eventTypeId must be a positive integer',
      },
      { status: 400 }
    );
  }
  const sendSms = parseSendSmsFromBody(body);

  try {
    await ensureChairDurationSchema();
    const existing = await loadAppointment(idParam);
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const parentId = String(existing.id);
    if (existing.attached_to_appointment_id) {
      return NextResponse.json(
        {
          error: 'not_a_visit',
          message: 'Change the main appointment, not an add-on.',
        },
        { status: 400 }
      );
    }

    const status = (existing.status || '').toLowerCase();
    if (status === 'pending') {
      return NextResponse.json(
        {
          error: 'checkout_hold',
          message: 'This visit is still a checkout hold.',
        },
        { status: 400 }
      );
    }
    if (status !== 'confirmed' && status !== 'accepted') {
      return NextResponse.json(
        {
          error: 'not_changeable',
          message: 'This visit can\u2019t be changed.',
        },
        { status: 400 }
      );
    }

    const startIso = serialiseDate(existing.booking_time);
    if (!startIso) {
      return NextResponse.json(
        {
          error: 'missing_start',
          message: 'This visit has no start time.',
        },
        { status: 400 }
      );
    }
    if (Date.parse(startIso) <= Date.now()) {
      return NextResponse.json(
        {
          error: 'already_started',
          message: 'This visit has already started.',
        },
        { status: 400 }
      );
    }

    if (await isSettled(parentId)) {
      return NextResponse.json(
        {
          error: 'already_paid',
          message: 'This visit has already been paid.',
        },
        { status: 400 }
      );
    }

    const currentEventTypeId =
      existing.cal_event_type_id == null
        ? null
        : Number(existing.cal_event_type_id);
    if (currentEventTypeId === eventTypeId) {
      return NextResponse.json(
        {
          error: 'same_service',
          message: 'This visit is already booked as that service.',
        },
        { status: 400 }
      );
    }

    const service = await loadCatalogueService(eventTypeId);
    if (!service) {
      return NextResponse.json(
        {
          error: 'service_not_found',
          message: `No active bookable service for Cal event type ${eventTypeId}`,
        },
        { status: 404 }
      );
    }

    const oldCatalogue = await loadCatalogueDurationMins(
      existing.cal_event_type_id
    );
    const currentChair = displayedChairDurationMins({
      chair_duration_mins: existing.chair_duration_mins,
      booking_time: existing.booking_time,
      end_time: existing.end_time,
    });
    const extraMins = await attachedExtraMinutes(parentId);
    const stretch =
      oldCatalogue != null
        ? Math.max(0, currentChair - oldCatalogue - extraMins)
        : 0;
    const newChair = snapChairDurationMins(
      service.duration_mins + extraMins + stretch
    );
    const newEndIso = endIsoFromDuration(startIso, newChair);
    if (!newEndIso) {
      return NextResponse.json(
        {
          error: 'invalid_duration',
          message: 'Could not compute the new end time.',
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
    const existingQuoted =
      existing.quoted_service_price_cents == null
        ? null
        : Number(existing.quoted_service_price_cents);
    const quotedCents =
      service.price != null
        ? Math.max(0, Math.round(service.price * 100))
        : existingQuoted != null && Number.isFinite(existingQuoted)
          ? Math.round(existingQuoted)
          : null;

    const overrideEventTypeId = parseAdminOverrideEventId();
    const calPayload: Record<string, unknown> = {
      eventTypeId,
      start: startIso,
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
        admin_service_change: 'true',
        original_service_name: service.title,
        original_cal_event_id: String(eventTypeId),
        original_service_duration_mins: String(service.duration_mins),
      },
    };

    // Same admin bypass as manual booking and reschedule: the new length
    // may sit on top of another visit, a blocked time, or outside the
    // public schedule. The visit being replaced also still occupies this start.
    calPayload.allowConflicts = true;
    calPayload.allowBookingOutOfBounds = true;

    let createApiVersion = CAL_BOOKINGS_API_VERSION;
    if (overrideEventTypeId != null) {
      createApiVersion = CAL_BOOKINGS_ADMIN_CREATE_API_VERSION;
    }

    let result = await proxyCalV2Post('/bookings', calPayload, createApiVersion);

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
          lengthInMinutes: newChair,
          allowConflicts: true,
          allowBookingOutOfBounds: true,
        };

        result = await proxyCalV2Post(
          '/bookings',
          shadowPayload,
          CAL_BOOKINGS_ADMIN_CREATE_API_VERSION
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
          '[api/admin/appointments/change-service] confirm follow-up failed',
          { uid: created.uid, confirmError }
        );
      }
    }

    const idAsString = parentId;
    const isUuid = UUID_RE.test(idAsString);
    const intId = parseIntegerId(idAsString);

    const writeRow = async (): Promise<AppointmentRow[]> => {
      if (isUuid) {
        const { rows } = await sql<AppointmentRow>`
          UPDATE appointments
          SET cal_event_id = ${created.uid},
              cal_event_type_id = ${eventTypeId},
              service_name = ${service.title},
              quoted_service_price_cents = ${quotedCents},
              booking_time = ${startIso},
              end_time = ${newEndIso},
              chair_duration_mins = ${newChair},
              status = 'confirmed'
          WHERE id = ${idAsString}::uuid
          RETURNING id, cal_event_id, cal_event_type_id, booking_time, end_time,
                    chair_duration_mins, status,
                    attached_to_appointment_id::text AS attached_to_appointment_id,
                    client_first_name, client_last_name, client_phone, client_email,
                    service_name, sms_opt_in, quoted_service_price_cents
        `;
        return rows;
      }
      if (intId !== null) {
        const { rows } = await sql<AppointmentRow>`
          UPDATE appointments
          SET cal_event_id = ${created.uid},
              cal_event_type_id = ${eventTypeId},
              service_name = ${service.title},
              quoted_service_price_cents = ${quotedCents},
              booking_time = ${startIso},
              end_time = ${newEndIso},
              chair_duration_mins = ${newChair},
              status = 'confirmed'
          WHERE id = ${intId}
          RETURNING id, cal_event_id, cal_event_type_id, booking_time, end_time,
                    chair_duration_mins, status,
                    attached_to_appointment_id::text AS attached_to_appointment_id,
                    client_first_name, client_last_name, client_phone, client_email,
                    service_name, sms_opt_in, quoted_service_price_cents
        `;
        return rows;
      }
      return [];
    };

    let rows: AppointmentRow[] = [];
    try {
      rows = await writeRow();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      try {
        await clearWebhookDuplicate(created.uid, idAsString);
        rows = await writeRow();
      } catch (retryErr) {
        await cancelOnCal(created.uid);
        throw retryErr;
      }
    }

    if (rows.length === 0) {
      await cancelOnCal(created.uid);
      return NextResponse.json({ error: 'update_failed' }, { status: 500 });
    }

    const row = rows[0];
    let calCancelError: string | null = null;
    const oldUid = existing.cal_event_id?.trim() || null;
    if (oldUid && oldUid !== created.uid) {
      calCancelError = await cancelOnCal(oldUid);
    }

    try {
      await syncAttachedExtrasTimes(String(row.id), row.booking_time, row.end_time);
    } catch (err) {
      console.warn(
        '[api/admin/appointments/change-service] extras time sync failed',
        { error: errorMessage(err) }
      );
    }

    const reminderEmails = await rescheduleAppointmentReminderEmails(
      row.cal_event_id || created.uid
    );

    const bookingTimeIso = serialiseDate(row.booking_time);
    const endTimeIso = serialiseDate(row.end_time);
    let serviceChangeSms: Record<string, unknown> | null = null;
    try {
      serviceChangeSms = await notifyAppointmentServiceChanged({
        bookingUid: row.cal_event_id || created.uid,
        bookingTime: bookingTimeIso,
        endTime: endTimeIso,
        clientPhone: row.client_phone,
        serviceName: row.service_name || service.title,
        smsOptIn: row.sms_opt_in,
        sendClientSms: sendSms,
      });
    } catch (smsErr) {
      console.warn(
        '[api/admin/appointments/change-service] SMS failed (non-blocking)',
        { error: errorMessage(smsErr) }
      );
    }

    return NextResponse.json({
      appointment: {
        id: row.id,
        cal_uid: row.cal_event_id,
        service_name: row.service_name,
        cal_event_type_id: row.cal_event_type_id,
        booking_time: bookingTimeIso,
        end_time: endTimeIso,
        status: row.status,
      },
      reminderEmails,
      serviceChangeSms,
      cal_cancel_error: calCancelError,
    });
  } catch (err) {
    console.error('[api/admin/appointments/change-service] failed', err);
    return NextResponse.json(
      { error: 'change_service_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
