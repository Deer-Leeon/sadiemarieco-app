/**
 * POST /api/booking/init
 *
 * Creates (or refreshes) a `pending` appointments row immediately after
 * the Cal.com embed fires `bookingSuccessful` — before the client reaches
 * /checkout. Clients are upserted by phone (CRM identifier); email is
 * still required for Stripe checkout and receipts.
 *
 * Idempotent on `cal_event_id`. Never downgrades status on conflict.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import {
  isValidEmail,
  normaliseClientPhoneForStorage,
  normalizeClientEmailForStorage,
} from '@/lib/client-identity';
import { extractCalBookingNotes } from '@/lib/cal-booking-notes';
import { upsertClientByPhonePrimary } from '@/lib/client-upsert';
import { scheduleAbandonedHoldRelease } from '@/lib/schedule-abandoned-hold-release';

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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function splitName(fullName: string): { first: string; last: string } {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
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

  return {
    calBookingUid,
    email,
    name,
    serviceName: serviceName || 'appointment',
    bookingTime: bookingTime || null,
    endTime: endTime || null,
    phone,
    bookingNotes: null,
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

    const bookingNotes =
      partial.bookingNotes || extractCalBookingNotes(booking as Record<string, unknown>);

    return {
      ...partial,
      email:
        partial.email ||
        normalizeClientEmailForStorage(attendeeEmail) ||
        '',
      name: partial.name || attendeeName,
      phone: partial.phone || attendeePhone,
      serviceName: partial.serviceName !== 'appointment' ? partial.serviceName : title || partial.serviceName,
      bookingTime: partial.bookingTime || start,
      endTime: partial.endTime || end,
      bookingNotes,
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

  let data = parsed;
  if (!data.email || !data.bookingTime || !data.bookingNotes) {
    data = await hydrateFromCal(data.calBookingUid, data);
  }

  if (!isValidEmail(data.email)) {
    return NextResponse.json(
      { error: 'no_email', message: 'Email is required for checkout and receipts.' },
      { status: 400 }
    );
  }

  const nameParts = splitName(data.name);
  const firstName = nameParts.first;
  const lastName = nameParts.last;
  const normPhone = normaliseClientPhoneForStorage(data.phone);

  if (!normPhone) {
    return NextResponse.json(
      {
        error: 'no_phone',
        message:
          'A valid phone number is required. Please add your phone in the booking form and try again.',
      },
      { status: 400 }
    );
  }

  let clientId: string;
  try {
    const upserted = await upsertClientByPhonePrimary({
      firstName,
      lastName,
      email: data.email,
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

  const appointmentPhone = normPhone;

  try {
    const { rowCount } = await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, end_time, cal_event_id,
        client_first_name, client_last_name, client_email, client_phone,
        booking_notes, status
      )
      VALUES (
        ${clientId}, ${data.serviceName}, ${data.bookingTime}, ${data.endTime},
        ${data.calBookingUid},
        ${firstName}, ${lastName}, ${data.email}, ${appointmentPhone},
        ${data.bookingNotes}, 'pending'
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        booking_time = EXCLUDED.booking_time,
        end_time = EXCLUDED.end_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = COALESCE(EXCLUDED.client_email, appointments.client_email),
        client_phone = EXCLUDED.client_phone,
        booking_notes = COALESCE(EXCLUDED.booking_notes, appointments.booking_notes)
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
