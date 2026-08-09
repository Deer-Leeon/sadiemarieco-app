/**
 * POST /api/book/create
 *
 * Phone booker: create a Cal booking, then run `/api/booking/init` so the
 * pending hold + checkout handoff match the embed flow. Does NOT confirm
 * on Cal (checkout / confirm does that after card vault).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  CONTACT_CHANNEL_REQUIRED_MESSAGE,
  hasBookingContactChannel,
} from '@/lib/booking-contact-channel';
import {
  analyticsServiceLabel,
  BOOKING_ANALYTICS_EVENTS,
  trackBookingEvent,
} from '@/lib/booking-analytics';
import { loadBookableServiceBySlug } from '@/lib/book-public';
import {
  CAL_STUDIO_IN_PERSON_LOCATION,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import {
  CAL_BOOKINGS_API_VERSION,
  proxyCalV2Post,
} from '@/lib/cal-proxy';
import {
  CalStartTimeError,
  parseBookingStartForCal,
} from '@/lib/cal-timezone';
import {
  calAttendeeEmailForBooking,
  clientPhoneValidationMessage,
  isValidEmail,
  normalizeClientEmailForStorage,
  parseClientPhone,
} from '@/lib/client-identity';
import { lookupBookingPhone } from '@/lib/phone-lookup';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CreateBody {
  slug?: unknown;
  start?: unknown;
  name?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
  email?: unknown;
  smsOptIn?: unknown;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

function extractBooking(payload: unknown): {
  uid: string | null;
  start: string | null;
  end: string | null;
  title: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return { uid: null, start: null, end: null, title: null };
  }
  const root = payload as Record<string, unknown>;
  const booking =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root.booking && typeof root.booking === 'object'
        ? (root.booking as Record<string, unknown>)
        : root;

  const uid = typeof booking.uid === 'string' ? booking.uid : null;
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
  const title =
    typeof booking.title === 'string'
      ? booking.title
      : typeof booking.eventTitle === 'string'
        ? booking.eventTitle
        : null;
  return { uid, start, end, title };
}

async function cancelCalBooking(uid: string): Promise<void> {
  try {
    await proxyCalV2Post(
      `/bookings/${encodeURIComponent(uid)}/cancel`,
      { cancellationReason: 'Phone booker hold init failed' },
      CAL_BOOKINGS_API_VERSION
    );
  } catch (err) {
    console.warn('[api/book/create] cancel after init failure failed', {
      uid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `book-create:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookCreate,
  });
  if (limited) return limited;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const startRaw = typeof body.start === 'string' ? body.start.trim() : '';
  const firstNameRaw =
    typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastNameRaw =
    typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const nameFromBody = typeof body.name === 'string' ? body.name.trim() : '';
  const split =
    firstNameRaw || lastNameRaw
      ? { first: firstNameRaw, last: lastNameRaw }
      : splitName(nameFromBody);
  const first = split.first;
  const last = split.last;
  const name = [first, last].filter(Boolean).join(' ');
  const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : '';
  const emailRaw =
    typeof body.email === 'string'
      ? normalizeClientEmailForStorage(body.email)
      : null;
  const smsOptIn = body.smsOptIn === true;

  if (!slug) {
    return NextResponse.json(
      { error: 'invalid_slug', message: 'Choose a service.' },
      { status: 400 }
    );
  }
  if (!startRaw) {
    return NextResponse.json(
      { error: 'invalid_start', message: 'Choose a date and time.' },
      { status: 400 }
    );
  }
  if (!first || first.length > 100) {
    return NextResponse.json(
      { error: 'invalid_name', message: 'Enter your first name.' },
      { status: 400 }
    );
  }
  if (!last || last.length > 100) {
    return NextResponse.json(
      { error: 'invalid_name', message: 'Enter your last name.' },
      { status: 400 }
    );
  }
  if (!name || name.length > 200) {
    return NextResponse.json(
      { error: 'invalid_name', message: 'Enter your first and last name.' },
      { status: 400 }
    );
  }

  const parsedPhone = parseClientPhone(phoneRaw);
  if (!parsedPhone) {
    return NextResponse.json(
      {
        error: 'phone_invalid',
        message: clientPhoneValidationMessage(),
      },
      { status: 400 }
    );
  }

  if (!hasBookingContactChannel({ email: emailRaw, smsOptIn })) {
    return NextResponse.json(
      {
        error: 'contact_required',
        message: CONTACT_CHANNEL_REQUIRED_MESSAGE,
      },
      { status: 400 }
    );
  }

  if (emailRaw && !isValidEmail(emailRaw)) {
    return NextResponse.json(
      { error: 'invalid_email', message: 'Enter a valid email address.' },
      { status: 400 }
    );
  }

  const phoneLookup = await lookupBookingPhone(phoneRaw, {
    requireSmsCapable: smsOptIn,
  });
  if (!phoneLookup.ok) {
    const status =
      phoneLookup.error === 'not_sms_capable' ? 422 : 400;
    return NextResponse.json(
      {
        error:
          phoneLookup.error === 'not_sms_capable'
            ? 'phone_not_sms_capable'
            : 'phone_invalid',
        message: phoneLookup.message,
      },
      { status }
    );
  }

  const service = await loadBookableServiceBySlug(slug);
  if (!service) {
    return NextResponse.json(
      { error: 'service_not_found', message: 'That service is not available.' },
      { status: 404 }
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

  const attendeeEmail = calAttendeeEmailForBooking(
    phoneLookup.digits,
    emailRaw
  );

  const calPayload: Record<string, unknown> = {
    eventTypeId: service.calEventId,
    start: startUtc.toISOString(),
    attendee: {
      name,
      email: attendeeEmail,
      phoneNumber: phoneLookup.e164,
      timeZone: STUDIO_TIMEZONE,
    },
    bookingFieldsResponses: {
      name: {
        firstName: first,
        lastName: last || first,
      },
      attendeePhoneNumber: phoneLookup.e164,
      'sms-consent': smsOptIn,
    },
    location: {
      type: CAL_STUDIO_IN_PERSON_LOCATION.type,
      address: CAL_STUDIO_IN_PERSON_LOCATION.address,
    },
    metadata: {
      phone_booker: 'true',
    },
  };

  const createResult = await proxyCalV2Post(
    '/bookings',
    calPayload,
    CAL_BOOKINGS_API_VERSION
  );
  if (!createResult.ok) return createResult.response;

  const extracted = extractBooking(createResult.data);
  if (!extracted.uid) {
    console.error('[api/book/create] Cal create missing uid', createResult.data);
    return NextResponse.json(
      {
        error: 'cal_create_failed',
        message: 'Could not create the booking hold. Please try again.',
      },
      { status: 502 }
    );
  }

  const initUrl = new URL('/api/booking/init', req.nextUrl.origin);
  let initRes: Response;
  try {
    initRes = await fetch(initUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-forwarded-for': clientIpFromRequest(req),
      },
      body: JSON.stringify({
        calBookingUid: extracted.uid,
        name,
        email: emailRaw || '',
        phone: phoneLookup.e164,
        serviceName: extracted.title || service.title,
        bookingTime: extracted.start || startUtc.toISOString(),
        endTime: extracted.end || null,
        smsOptIn,
      }),
      cache: 'no-store',
    });
  } catch (err) {
    await cancelCalBooking(extracted.uid);
    console.error('[api/book/create] init fetch failed', err);
    return NextResponse.json(
      {
        error: 'init_failed',
        message: 'Could not start checkout. Please try again.',
      },
      { status: 502 }
    );
  }

  const initData = (await initRes.json().catch(() => null)) as {
    error?: string;
    message?: string;
    ok?: boolean;
  } | null;

  if (!initRes.ok) {
    await cancelCalBooking(extracted.uid);
    return NextResponse.json(
      {
        error: initData?.error || 'init_failed',
        message:
          initData?.message ||
          'Could not start checkout. Please try again.',
      },
      { status: initRes.status >= 400 && initRes.status < 600 ? initRes.status : 502 }
    );
  }

  await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.DETAILS_SUBMITTED, {
    service: analyticsServiceLabel(service.title),
    source: 'phone_booker',
  });

  return NextResponse.json({
    ok: true,
    calBookingUid: extracted.uid,
    name,
    email: emailRaw || '',
    serviceName: service.title,
    bookingTime: extracted.start || startUtc.toISOString(),
    endTime: extracted.end,
  });
}
