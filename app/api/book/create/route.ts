/**
 * POST /api/book/create
 *
 * Phone booker: create a Cal booking, then run `/api/booking/init` so the
 * pending hold + checkout handoff match the embed flow. Does NOT confirm
 * on Cal (checkout / confirm does that after card vault).
 */

import { NextRequest, NextResponse } from 'next/server';

import { sql } from '@vercel/postgres';

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
  sqlPhoneVariants,
} from '@/lib/client-identity';
import { getAppointmentHoldByCalUid } from '@/lib/appointment-hold';
import { isHoldExpired } from '@/lib/booking-hold';
import { lookupBookingPhone } from '@/lib/phone-lookup';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';
import { releaseAbandonedHoldByCalUid } from '@/lib/release-abandoned-hold';
import { scheduleAbandonedHoldRelease } from '@/lib/schedule-abandoned-hold-release';

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
  source?: unknown;
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

const CAL_SLOT_CONFLICT_RE =
  /already has booking at this time|not available|already booked|no longer available|overlapping|conflict/i;

// Deliberately does NOT echo the existing appointment's date/time: this
// endpoint is unauthenticated, so a specific time would let anyone who
// knows a client's phone number probe for their appointment schedule.
function friendlySlotConflictMessage(): string {
  return 'That time is no longer available — you may already have an appointment then. Payment did not go through. Pick another time.';
}

async function findExistingHoldForPhone(params: {
  phoneDigits: string;
  startUtc: Date;
  durationMins: number;
  serviceTitle: string;
}): Promise<
  | {
      kind: 'reuse_pending';
      calBookingUid: string;
      bookingTime: string | null;
      endTime: string | null;
      serviceName: string | null;
      createdAt: string | null;
    }
  | { kind: 'conflict'; bookingTime: string | null; endTime: string | null }
  | null
> {
  const [phoneV0, phoneV1] = sqlPhoneVariants(params.phoneDigits);
  const startIso = params.startUtc.toISOString();
  const endUtc = new Date(
    params.startUtc.getTime() + params.durationMins * 60_000
  );

  const { rows } = await sql<{
    cal_event_id: string | null;
    status: string | null;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    created_at: Date | string | null;
    service_name: string | null;
  }>`
    SELECT
      cal_event_id,
      status,
      booking_time,
      end_time,
      created_at,
      service_name
    FROM appointments
    WHERE regexp_replace(COALESCE(client_phone, ''), '\\D', '', 'g') IN (
        ${phoneV0},
        ${phoneV1}
      )
      AND booking_time IS NOT NULL
      AND LOWER(COALESCE(status, 'pending')) IN ('pending', 'confirmed', 'accepted')
      AND booking_time < ${endUtc.toISOString()}
      AND COALESCE(
        end_time,
        booking_time + make_interval(mins => ${params.durationMins})
      ) > ${startIso}
    ORDER BY created_at DESC NULLS LAST
    LIMIT 8
  `;

  const serialize = (value: Date | string | null): string | null => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  for (const row of rows) {
    const bookingTime = serialize(row.booking_time);
    const endTime = serialize(row.end_time);
    const status = (row.status || 'pending').toLowerCase();
    const uid = typeof row.cal_event_id === 'string' ? row.cal_event_id.trim() : '';
    const startMs = bookingTime ? new Date(bookingTime).getTime() : NaN;
    const sameStart =
      Number.isFinite(startMs) &&
      Math.abs(startMs - params.startUtc.getTime()) < 60_000;

    if (status === 'pending') {
      if (isHoldExpired(row.created_at)) continue;
      // Reuse only when it is genuinely the SAME booking retried: same
      // start AND same service. A different service at the same start
      // would hand back a hold priced/booked for the old service.
      const sameService =
        (row.service_name ?? '').trim().toLowerCase() ===
        params.serviceTitle.trim().toLowerCase();
      if (sameStart && sameService && uid) {
        return {
          kind: 'reuse_pending',
          calBookingUid: uid,
          bookingTime,
          endTime,
          serviceName: row.service_name,
          createdAt: serialize(row.created_at),
        };
      }
      return { kind: 'conflict', bookingTime, endTime };
    }

    if (status === 'confirmed' || status === 'accepted') {
      return { kind: 'conflict', bookingTime, endTime };
    }
  }

  return null;
}

async function mapCalCreateFailure(response: NextResponse): Promise<NextResponse> {
  const payload = (await response.clone().json().catch(() => null)) as {
    message?: string;
  } | null;
  const raw = typeof payload?.message === 'string' ? payload.message : '';
  if (CAL_SLOT_CONFLICT_RE.test(raw)) {
    return NextResponse.json(
      {
        error: 'slot_unavailable',
        message: friendlySlotConflictMessage(),
      },
      { status: 409 }
    );
  }
  return response;
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
  const sourceRaw = typeof body.source === 'string' ? body.source.trim() : '';
  const analyticsSource =
    sourceRaw === 'phone_booker_apple_pay'
      ? 'phone_booker_apple_pay'
      : 'phone_booker';

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

  try {
    const existing = await findExistingHoldForPhone({
      phoneDigits: phoneLookup.digits,
      startUtc,
      durationMins: service.durationMins,
      serviceTitle: service.title,
    });
    if (existing?.kind === 'conflict') {
      return NextResponse.json(
        {
          error: 'slot_unavailable',
          message: friendlySlotConflictMessage(),
        },
        { status: 409 }
      );
    }
    if (existing?.kind === 'reuse_pending') {
      await trackBookingEvent(BOOKING_ANALYTICS_EVENTS.DETAILS_SUBMITTED, {
        service: analyticsServiceLabel(service.title),
        source: analyticsSource,
      });
      return NextResponse.json({
        ok: true,
        calBookingUid: existing.calBookingUid,
        name,
        email: emailRaw || '',
        serviceName: existing.serviceName || service.title,
        bookingTime: existing.bookingTime || startUtc.toISOString(),
        endTime: existing.endTime,
        createdAt: existing.createdAt,
      });
    }
  } catch (err) {
    console.warn('[api/book/create] existing-hold lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
  if (!createResult.ok) return mapCalCreateFailure(createResult.response);

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

  // Schedule before init so a crash / init failure still auto-releases.
  // Duplicate with init + webhook is fine (release is idempotent).
  try {
    const releaseJob = await scheduleAbandonedHoldRelease(extracted.uid);
    if (!releaseJob.scheduled) {
      console.warn('[api/book/create] abandoned-hold release not scheduled', {
        calBookingUid: extracted.uid,
        reason: releaseJob.reason,
      });
    }
  } catch (err) {
    console.warn('[api/book/create] abandoned-hold schedule threw', {
      calBookingUid: extracted.uid,
      error: err instanceof Error ? err.message : String(err),
    });
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
    // Flip any webhook-created pending row immediately (don't wait for QStash).
    // No abandoned SMS — this is an init rollback, not a real checkout abandon.
    try {
      await releaseAbandonedHoldByCalUid(extracted.uid, {
        sendAbandonedSms: false,
      });
    } catch (releaseErr) {
      console.warn('[api/book/create] local release after init fetch failure', {
        uid: extracted.uid,
        error:
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
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
    try {
      await releaseAbandonedHoldByCalUid(extracted.uid, {
        sendAbandonedSms: false,
      });
    } catch (releaseErr) {
      console.warn('[api/book/create] local release after init failure', {
        uid: extracted.uid,
        error:
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
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
    source: analyticsSource,
  });

  const hold = await getAppointmentHoldByCalUid(extracted.uid);
  return NextResponse.json({
    ok: true,
    calBookingUid: extracted.uid,
    name,
    email: emailRaw || '',
    serviceName: service.title,
    bookingTime: extracted.start || startUtc.toISOString(),
    endTime: extracted.end,
    createdAt: hold?.created_at ?? new Date().toISOString(),
  });
}
