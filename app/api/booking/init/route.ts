/**
 * POST /api/booking/init
 *
 * Creates (or refreshes) a `pending` appointments row immediately after
 * the Cal.com embed fires `bookingSuccessful` — before the client reaches
 * /checkout. Clients are upserted by phone (CRM identifier); email is
 * optional, but email OR SMS opt-in is required so we can reach them.
 *
 * Idempotent on `cal_event_id`. Never downgrades status on conflict.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
  trackBookingEvent,
} from '@/lib/booking-analytics';
import {
  CONTACT_CHANNEL_REQUIRED_MESSAGE,
  hasBookingContactChannel,
  parseSmsOptInFromSources,
} from '@/lib/booking-contact-channel';
import {
  isValidEmail,
  normaliseClientPhoneForStorage,
  normalizeClientEmailForStorage,
} from '@/lib/client-identity';
import { extractCalBookingNotes } from '@/lib/cal-booking-notes';
import { upsertClientByPhonePrimary } from '@/lib/client-upsert';
import { lookupBookingPhone } from '@/lib/phone-lookup';
import { scheduleAbandonedHoldRelease } from '@/lib/schedule-abandoned-hold-release';
import { canonicalAppointmentServiceName } from '@/lib/match-catalogue-service';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CAL_V2_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

interface InitBody {
  calBookingUid?: unknown;
  email?: unknown;
  name?: unknown;
  serviceName?: unknown;
  bookingTime?: unknown;
  endTime?: unknown;
  phone?: unknown;
  smsOptIn?: unknown;
  eventTypeId?: unknown;
}

interface ParsedInit {
  calBookingUid: string;
  email: string;
  name: string;
  serviceName: string;
  bookingTime: string | null;
  endTime: string | null;
  phone: string;
  bookingNotes: string | null;
  smsOptIn: boolean | undefined;
  calEventTypeId: number | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractCalEventTypeId(source: unknown): number | null {
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : null;
  const nested =
    record.eventType && typeof record.eventType === 'object'
      ? (record.eventType as Record<string, unknown>)
      : null;
  const raw =
    metadata?.original_cal_event_id ??
    metadata?.originalCalEventId ??
    record.eventTypeId ??
    record.eventTypeID ??
    nested?.id ??
    nested?.eventTypeId ??
    null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function splitName(fullName: string): { first: string; last: string } {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

/** Best-effort QStash schedule — never throws; used on init failure paths. */
async function scheduleReleaseBestEffort(
  calBookingUid: string,
  context: string
): Promise<void> {
  try {
    const releaseJob = await scheduleAbandonedHoldRelease(calBookingUid);
    if (!releaseJob.scheduled) {
      console.warn(
        '[api/booking/init] abandoned-hold release not scheduled',
        {
          calBookingUid,
          context,
          reason: releaseJob.reason,
        }
      );
    }
  } catch (err) {
    console.warn('[api/booking/init] abandoned-hold schedule threw', {
      calBookingUid,
      context,
      error: errorMessage(err),
    });
  }
}

function parseInitBody(input: unknown): ParsedInit | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body' };
  }
  const body = input as InitBody;
  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const serviceName =
    typeof body.serviceName === 'string' ? body.serviceName.trim() : '';
  const bookingTime =
    typeof body.bookingTime === 'string' ? body.bookingTime.trim() : null;
  const endTime = typeof body.endTime === 'string' ? body.endTime.trim() : null;
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';

  if (!calBookingUid || calBookingUid.length > 200) {
    return { error: 'invalid_cal_booking_uid' };
  }

  const email = normalizeClientEmailForStorage(rawEmail) ?? '';
  const name = rawName.length > 0 && rawName.length <= 200 ? rawName : '';
  const smsOptIn =
    body.smsOptIn === true
      ? true
      : body.smsOptIn === false
        ? false
        : undefined;

  return {
    calBookingUid,
    email,
    name,
    serviceName: serviceName || 'appointment',
    bookingTime: bookingTime || null,
    endTime: endTime || null,
    phone,
    bookingNotes: null,
    smsOptIn,
    calEventTypeId: extractCalEventTypeId(body),
  };
}

/** Pull attendee + schedule fields from Cal when the embed omitted them. */
async function hydrateFromCal(
  uid: string,
  partial: ParsedInit
): Promise<ParsedInit> {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) return partial;

  try {
    const upstream = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(uid)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_API_VERSION,
          Accept: 'application/json',
        },
      }
    );
    if (!upstream.ok) return partial;

    const payload = await upstream.json().catch(() => null);
    const booking =
      payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data: Record<string, unknown> }).data
        : (payload as Record<string, unknown> | null);

    if (!booking || typeof booking !== 'object') return partial;

    const attendees = Array.isArray(booking.attendees)
      ? (booking.attendees as Array<Record<string, unknown>>)
      : [];
    const attendee = attendees[0] ?? {};
    const attendeeEmail =
      typeof attendee.email === 'string' ? attendee.email.trim() : '';
    const attendeeName =
      typeof attendee.name === 'string' ? attendee.name.trim() : '';
    const attendeePhone =
      typeof attendee.phoneNumber === 'string'
        ? attendee.phoneNumber.trim()
        : '';

    const title =
      typeof booking.title === 'string' ? booking.title.trim() : '';
    const start =
      typeof booking.start === 'string'
        ? booking.start
        : typeof booking.startTime === 'string'
          ? booking.startTime
          : null;
    const end =
      typeof booking.end === 'string'
        ? booking.end
        : typeof booking.endTime === 'string'
          ? booking.endTime
          : null;

    const responses =
      booking.responses && typeof booking.responses === 'object'
        ? (booking.responses as Record<string, unknown>)
        : null;
    const fieldResponses =
      booking.bookingFieldsResponses &&
      typeof booking.bookingFieldsResponses === 'object'
        ? (booking.bookingFieldsResponses as Record<string, unknown>)
        : null;
    const smsFromCal = parseSmsOptInFromSources(responses, fieldResponses);

    const bookingNotes =
      partial.bookingNotes ||
      extractCalBookingNotes(booking as Record<string, unknown>);

    return {
      ...partial,
      email:
        partial.email ||
        normalizeClientEmailForStorage(attendeeEmail) ||
        '',
      name: partial.name || attendeeName,
      phone: partial.phone || attendeePhone,
      serviceName:
        partial.serviceName !== 'appointment'
          ? partial.serviceName
          : title || partial.serviceName,
      bookingTime: partial.bookingTime || start,
      endTime: partial.endTime || end,
      bookingNotes,
      smsOptIn:
        partial.smsOptIn === true
          ? true
          : smsFromCal === true
            ? true
            : partial.smsOptIn === false
              ? false
              : smsFromCal,
      calEventTypeId:
        partial.calEventTypeId ?? extractCalEventTypeId(booking),
    };
  } catch (err) {
    console.warn('[api/booking/init] Cal hydrate failed (non-fatal)', {
      uid,
      error: errorMessage(err),
    });
    return partial;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `booking:init:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookingInit,
  });
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseInitBody(raw);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Always hydrate when contact channel is incomplete or schedule/notes missing.
  let data = parsed;
  const needsHydrate =
    !hasBookingContactChannel({
      email: data.email,
      smsOptIn: data.smsOptIn,
    }) ||
    !data.bookingTime ||
    !data.bookingNotes ||
    !data.phone ||
    data.calEventTypeId == null;
  if (needsHydrate) {
    data = await hydrateFromCal(data.calBookingUid, data);
  }

  data = {
    ...data,
    serviceName: await canonicalAppointmentServiceName(
      data.serviceName,
      data.calEventTypeId
    ),
  };

  if (
    !hasBookingContactChannel({
      email: data.email,
      smsOptIn: data.smsOptIn,
    })
  ) {
    // Cal booking already exists (embed / webhook). Schedule release so the
    // slot is not held forever when init cannot write the local row.
    await scheduleReleaseBestEffort(
      data.calBookingUid,
      'contact_required'
    );
    return NextResponse.json(
      {
        error: 'contact_required',
        message: CONTACT_CHANNEL_REQUIRED_MESSAGE,
      },
      { status: 400 }
    );
  }

  // Prefer a real address when Cal (or the client) provided one; otherwise
  // store NULL and let receipt / reminder emails skip gracefully.
  const storedEmail = isValidEmail(data.email) ? data.email : null;
  const smsOptIn = data.smsOptIn === true;

  const nameParts = splitName(data.name);
  const firstName = nameParts.first;
  const lastName = nameParts.last;
  const normPhone = normaliseClientPhoneForStorage(data.phone);

  if (!normPhone) {
    await scheduleReleaseBestEffort(data.calBookingUid, 'no_phone');
    return NextResponse.json(
      {
        error: 'no_phone',
        message:
          'A valid phone number is required. Please add your phone in the booking form and try again.',
      },
      { status: 400 }
    );
  }

  const phoneLookup = await lookupBookingPhone(data.phone, {
    requireSmsCapable: smsOptIn,
  });
  if (!phoneLookup.ok) {
    await scheduleReleaseBestEffort(
      data.calBookingUid,
      phoneLookup.error === 'not_sms_capable'
        ? 'phone_not_sms_capable'
        : 'phone_invalid'
    );
    return NextResponse.json(
      {
        error:
          phoneLookup.error === 'not_sms_capable'
            ? 'phone_not_sms_capable'
            : 'phone_invalid',
        message: phoneLookup.message,
      },
      { status: 400 }
    );
  }

  let clientId: string;
  try {
    const upserted = await upsertClientByPhonePrimary({
      firstName,
      lastName,
      email: storedEmail,
      phoneRaw: data.phone,
    });
    clientId = upserted.clientId;
  } catch (err) {
    console.error('[api/booking/init] client upsert failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'client_upsert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  const appointmentPhone = phoneLookup.digits;

  try {
    const { rowCount } = await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, end_time, cal_event_id,
        cal_event_type_id,
        client_first_name, client_last_name, client_email, client_phone,
        booking_notes, status, sms_opt_in
      )
      VALUES (
        ${clientId}, ${data.serviceName}, ${data.bookingTime}, ${data.endTime},
        ${data.calBookingUid}, ${data.calEventTypeId},
        ${firstName}, ${lastName}, ${storedEmail}, ${appointmentPhone},
        ${data.bookingNotes}, 'pending', ${smsOptIn ? true : null}
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        cal_event_type_id = COALESCE(
          EXCLUDED.cal_event_type_id,
          appointments.cal_event_type_id
        ),
        quoted_service_price_cents = COALESCE(
          appointments.quoted_service_price_cents,
          EXCLUDED.quoted_service_price_cents
        ),
        booking_time = EXCLUDED.booking_time,
        end_time = EXCLUDED.end_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = COALESCE(
          EXCLUDED.client_email,
          CASE
            WHEN appointments.client_email IS NULL THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE '%@sms.cal.com' THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE 'bookings+%' THEN NULL
            WHEN LOWER(TRIM(appointments.client_email)) LIKE '%@placeholder.sadiemarie.co' THEN NULL
            ELSE appointments.client_email
          END
        ),
        client_phone = EXCLUDED.client_phone,
        booking_notes = COALESCE(EXCLUDED.booking_notes, appointments.booking_notes),
        sms_opt_in = CASE
          WHEN EXCLUDED.sms_opt_in IS TRUE THEN TRUE
          ELSE appointments.sms_opt_in
        END
    `;

    // One-shot delayed release — replaces the high-frequency cleanup cron.
    // Failures are logged inside the helper; never block checkout init.
    const releaseJob = await scheduleAbandonedHoldRelease(data.calBookingUid);
    if (!releaseJob.scheduled) {
      console.warn('[api/booking/init] abandoned-hold release not scheduled', {
        calBookingUid: data.calBookingUid,
        reason: releaseJob.reason,
      });
    }

    await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.HOLD_CREATED, {
      service: analyticsServiceLabel(data.serviceName),
    });

    return NextResponse.json({
      ok: true,
      calBookingUid: data.calBookingUid,
      inserted: (rowCount ?? 0) > 0,
      status: 'pending',
      releaseScheduled: releaseJob.scheduled,
    });
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/booking/init] appointment insert failed:', msg);
    return NextResponse.json(
      { error: 'appointment_upsert_failed', message: msg },
      { status: 500 }
    );
  }
}
