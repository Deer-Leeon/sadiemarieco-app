/**
 * POST /api/admin/manual-booking/create
 *
 * Admin-only proxy to create a Cal.com v2 booking without public checkout.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import {
  CalStartTimeError,
  parseBookingStartForCal,
} from '@/lib/cal-timezone';
import {
  calAttendeeEmailForBooking,
  clientPhoneValidationMessage,
  parseClientPhone,
  parseOptionalClientEmail,
} from '@/lib/client-identity';
import {
  CAL_BOOKINGS_API_VERSION,
  confirmCalV2Booking,
  gateAdmin,
  proxyCalV2Post,
} from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CreateBody {
  eventTypeId?: unknown;
  start?: unknown;
  clientFirstName?: unknown;
  clientLastName?: unknown;
  clientName?: unknown;
  clientEmail?: unknown;
  clientPhone?: unknown;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

function parseCreateBody(input: unknown):
  | {
      eventTypeId: number;
      start: string;
      clientFirstName: string;
      clientLastName: string;
      clientName: string;
      clientEmail: string | null;
      clientPhone: string;
      clientPhoneE164: string;
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
  const clientFirstName =
    typeof body.clientFirstName === 'string' ? body.clientFirstName.trim() : '';
  const clientLastName =
    typeof body.clientLastName === 'string' ? body.clientLastName.trim() : '';
  const clientNameFromBody =
    typeof body.clientName === 'string' ? body.clientName.trim() : '';
  const clientEmail = parseOptionalClientEmail(body.clientEmail);
  const parsedPhone = parseClientPhone(body.clientPhone);

  let clientFirst = clientFirstName;
  let clientLast = clientLastName;
  if (!clientFirst && !clientLast && clientNameFromBody) {
    const split = splitName(clientNameFromBody);
    clientFirst = split.first;
    clientLast = split.last;
  }
  const clientName = [clientFirst, clientLast].filter(Boolean).join(' ');

  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return {
      error: 'invalid_event_type_id',
      message: 'eventTypeId must be a positive integer',
    };
  }
  if (!start) {
    return { error: 'invalid_start', message: 'start is required' };
  }
  if (!clientFirst || clientFirst.length > 100) {
    return {
      error: 'invalid_client_first_name',
      message: 'clientFirstName is required',
    };
  }
  if (!clientLast || clientLast.length > 100) {
    return {
      error: 'invalid_client_last_name',
      message: 'clientLastName is required',
    };
  }
  if (!clientName || clientName.length > 200) {
    return { error: 'invalid_client_name', message: 'clientName is required' };
  }
  if (
    body.clientEmail !== undefined &&
    body.clientEmail !== null &&
    typeof body.clientEmail === 'string' &&
    body.clientEmail.trim().length > 0 &&
    !clientEmail
  ) {
    return {
      error: 'invalid_client_email',
      message: 'clientEmail must be a valid email address when provided',
    };
  }
  if (!parsedPhone) {
    return {
      error: 'invalid_client_phone',
      message: clientPhoneValidationMessage(),
    };
  }

  return {
    eventTypeId,
    start,
    clientFirstName: clientFirst,
    clientLastName: clientLast,
    clientName,
    clientEmail,
    clientPhone: parsedPhone.digits,
    clientPhoneE164: parsedPhone.e164,
  };
}

function extractBooking(
  payload: unknown
): { uid: string | null; status: string | null } {
  if (!payload || typeof payload !== 'object') {
    return { uid: null, status: null };
  }

  const root = payload as Record<string, unknown>;
  const booking =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root.booking && typeof root.booking === 'object'
        ? (root.booking as Record<string, unknown>)
        : root;

  const uid = typeof booking.uid === 'string' ? booking.uid : null;
  const status = typeof booking.status === 'string' ? booking.status : null;
  return { uid, status };
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

  const overrideEventTypeId = parseAdminOverrideEventId();
  let calEventTypeId = parsed.eventTypeId;
  let originalServiceName: string | undefined;
  let lengthInMinutes: number | undefined;

  if (overrideEventTypeId != null) {
    const service = await loadServiceByCalEventId(parsed.eventTypeId);
    if (!service) {
      return NextResponse.json(
        {
          error: 'service_not_found',
          message: `No active bookable service for Cal event type ${parsed.eventTypeId}`,
        },
        { status: 404 }
      );
    }

    calEventTypeId = overrideEventTypeId;
    lengthInMinutes = service.duration_mins;
    originalServiceName = service.title;
  }

  const calPayload: Record<string, unknown> = {
    eventTypeId: calEventTypeId,
    start: startUtc.toISOString(),
    attendee: {
      name: parsed.clientName,
      email: calAttendeeEmailForBooking(parsed.clientPhone, parsed.clientEmail),
      phoneNumber: parsed.clientPhoneE164,
      timeZone: STUDIO_TIMEZONE,
    },
    bookingFieldsResponses: {
      name: {
        firstName: parsed.clientFirstName,
        lastName: parsed.clientLastName,
      },
      attendeePhoneNumber: parsed.clientPhoneE164,
    },
    metadata: {
      manual_admin_booking: 'true',
      ...(originalServiceName
        ? { original_service_name: originalServiceName }
        : {}),
    },
  };

  // Cal.com v2 (2024-08-13) rejects top-level `description` and `end` on create;
  // duration is expressed via `lengthInMinutes` only.
  if (lengthInMinutes != null) {
    calPayload.lengthInMinutes = lengthInMinutes;
  }

  const result = await proxyCalV2Post(
    '/bookings',
    calPayload,
    CAL_BOOKINGS_API_VERSION
  );
  if (!result.ok) return result.response;

  const { uid, status } = extractBooking(result.data);

  if (uid && status && status.toUpperCase() !== 'ACCEPTED') {
    const confirmError = await confirmCalV2Booking(uid);
    if (confirmError) {
      console.warn('[api/admin/manual-booking/create] confirm follow-up failed', {
        uid,
        confirmError,
      });
    }
  }

  return NextResponse.json(result.data);
}
