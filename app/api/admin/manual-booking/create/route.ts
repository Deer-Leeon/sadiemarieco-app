/**
 * POST /api/admin/manual-booking/create
 *
 * Admin-only proxy to create a Cal.com v1 booking without public checkout.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import {
  addMinutesUtc,
  CalStartTimeError,
  parseBookingStartForCal,
} from '@/lib/cal-timezone';
import {
  calUpstreamErrorMessage,
  errorMessage,
  gateAdmin,
  proxyCalV1Post,
  requireCalApiKey,
} from '@/lib/cal-v1-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CreateBody {
  eventTypeId?: unknown;
  start?: unknown;
  clientName?: unknown;
  clientEmail?: unknown;
  clientPhone?: unknown;
}

function parseCreateBody(input: unknown):
  | {
      eventTypeId: number;
      start: string;
      clientName: string;
      clientEmail: string;
      clientPhone: string;
    }
  | { error: string; message: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body', message: 'Request body must be a JSON object' };
  }
  const body = input as CreateBody;

  const eventTypeId =
    typeof body.eventTypeId === 'number'
      ? body.eventTypeId
      : typeof body.eventTypeId === 'string'
        ? Number(body.eventTypeId)
        : NaN;

  const start = typeof body.start === 'string' ? body.start.trim() : '';
  const clientName =
    typeof body.clientName === 'string' ? body.clientName.trim() : '';
  const clientEmail =
    typeof body.clientEmail === 'string' ? body.clientEmail.trim() : '';
  const clientPhone =
    typeof body.clientPhone === 'string' ? body.clientPhone.trim() : '';

  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return {
      error: 'invalid_event_type_id',
      message: 'eventTypeId must be a positive integer',
    };
  }
  if (!start) {
    return { error: 'invalid_start', message: 'start is required' };
  }
  if (!clientName || clientName.length > 200) {
    return { error: 'invalid_client_name', message: 'clientName is required' };
  }
  if (!clientEmail || !EMAIL_RE.test(clientEmail) || clientEmail.length > 254) {
    return {
      error: 'invalid_client_email',
      message: 'clientEmail must be a valid email address',
    };
  }
  if (!clientPhone || clientPhone.length > 40) {
    return {
      error: 'invalid_client_phone',
      message: 'clientPhone is required',
    };
  }

  return { eventTypeId, start, clientName, clientEmail, clientPhone };
}

async function loadDurationMins(eventTypeId: number): Promise<number> {
  try {
    const { rows } = await sql<{ duration_mins: number | null }>`
      SELECT duration_mins
      FROM site_services
      WHERE cal_event_id = ${eventTypeId}
        AND is_active = TRUE
      LIMIT 1
    `;
    const mins = rows[0]?.duration_mins;
    if (typeof mins === 'number' && mins > 0 && mins <= 24 * 60) {
      return mins;
    }
  } catch (err) {
    console.warn('[api/admin/manual-booking/create] duration lookup failed', {
      eventTypeId,
      error: errorMessage(err),
    });
  }
  return 60;
}

/** If Cal leaves the booking pending, accept it (same pattern as /api/booking/confirm). */
async function acceptBookingOnCal(bookingUid: string): Promise<string | null> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return 'Cal.com API key is not configured';
  }

  try {
    const res = await fetch(
      `https://api.cal.com/v1/bookings/${encodeURIComponent(bookingUid)}?apiKey=${encodeURIComponent(apiKey)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ status: 'ACCEPTED' }),
      }
    );
    if (res.ok) return null;
    const payload: unknown = await res.json().catch(() => null);
    return calUpstreamErrorMessage(payload, res.status);
  } catch (err) {
    return errorMessage(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const parsed = parseCreateBody(rawBody);
  if ('error' in parsed) {
    return NextResponse.json(
      { error: parsed.error, message: parsed.message },
      { status: 400 }
    );
  }

  let startUtc: Date;
  try {
    startUtc = parseBookingStartForCal(parsed.start);
  } catch (err) {
    const message =
      err instanceof CalStartTimeError ? err.message : 'Invalid start time';
    return NextResponse.json(
      { error: 'invalid_start', message },
      { status: 400 }
    );
  }

  const durationMins = await loadDurationMins(parsed.eventTypeId);
  const endUtc = addMinutesUtc(startUtc, durationMins);

  const calPayload = {
    eventTypeId: parsed.eventTypeId,
    start: startUtc.toISOString(),
    end: endUtc.toISOString(),
    timeZone: STUDIO_TIMEZONE,
    language: 'en',
    status: 'ACCEPTED',
    metadata: {
      manual_admin_booking: true,
    },
    responses: {
      name: parsed.clientName,
      email: parsed.clientEmail,
      smsReminderNumber: parsed.clientPhone,
      attendeePhoneNumber: parsed.clientPhone,
    },
  };

  const result = await proxyCalV1Post('/bookings', calPayload);
  if (!result.ok) return result.response;

  const booking =
    result.data &&
    typeof result.data === 'object' &&
    'booking' in (result.data as object)
      ? (result.data as { booking?: { uid?: string; status?: string } }).booking
      : (result.data as { uid?: string; status?: string } | null);

  const uid =
    booking && typeof booking === 'object' && typeof booking.uid === 'string'
      ? booking.uid
      : null;
  const status =
    booking && typeof booking === 'object' && typeof booking.status === 'string'
      ? booking.status
      : null;

  if (uid && status && status.toUpperCase() !== 'ACCEPTED') {
    const acceptError = await acceptBookingOnCal(uid);
    if (acceptError) {
      console.warn('[api/admin/manual-booking/create] accept follow-up failed', {
        uid,
        acceptError,
      });
    }
  }

  return NextResponse.json(result.data);
}
