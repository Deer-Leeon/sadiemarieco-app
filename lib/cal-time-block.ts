/**
 * Create / cancel Cal.com bookings that hold studio time without CRM side
 * effects. Uses the admin override shadow event with metadata
 * `admin_time_block: true` so the webhook skips Postgres ingest.
 *
 * Long blocks are split into consecutive allowed-duration Cal bookings
 * (see `planCalTimeBlockSegments`).
 */

import {
  CAL_ADMIN_OVERRIDE_BOOKING_LOCATION,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import { planCalTimeBlockSegments } from '@/lib/cal-time-block-segments';
import {
  CAL_BOOKINGS_ADMIN_CREATE_API_VERSION,
  CAL_BOOKINGS_API_VERSION,
  CAL_V2_BASE,
  calUpstreamErrorMessage,
  confirmCalV2Booking,
  proxyCalV2Post,
} from '@/lib/cal-proxy';
import { parseBookingStartForCal } from '@/lib/cal-timezone';
import { calAttendeeEmailForBooking } from '@/lib/client-identity';

const BLOCK_ATTENDEE_PHONE = '+13853383920';
const BLOCK_ATTENDEE_NAME = 'Studio Block';

function extractBookingUid(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const data =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  const uid = data.uid;
  return typeof uid === 'string' && uid.trim() ? uid.trim() : null;
}

async function createCalTimeBlockSegment(args: {
  startUtc: Date;
  durationMinutes: number;
  overrideEventTypeId: number;
}): Promise<{ ok: true; uid: string } | { ok: false; error: string }> {
  const phoneDigits = BLOCK_ATTENDEE_PHONE.replace(/\D/g, '');
  const calPayload: Record<string, unknown> = {
    eventTypeId: args.overrideEventTypeId,
    start: args.startUtc.toISOString(),
    lengthInMinutes: args.durationMinutes,
    attendee: {
      name: BLOCK_ATTENDEE_NAME,
      email: calAttendeeEmailForBooking(phoneDigits, null),
      phoneNumber: BLOCK_ATTENDEE_PHONE,
      timeZone: STUDIO_TIMEZONE,
    },
    bookingFieldsResponses: {
      name: { firstName: 'Studio', lastName: 'Block' },
      attendeePhoneNumber: BLOCK_ATTENDEE_PHONE,
    },
    location: CAL_ADMIN_OVERRIDE_BOOKING_LOCATION,
    metadata: {
      admin_time_block: 'true',
    },
    allowConflicts: true,
    allowBookingOutOfBounds: true,
  };

  const result = await proxyCalV2Post(
    '/bookings',
    calPayload,
    CAL_BOOKINGS_ADMIN_CREATE_API_VERSION
  );

  if (!result.ok) {
    const payload = await result.response.clone().json().catch(() => null);
    return {
      ok: false,
      error: calUpstreamErrorMessage(payload, result.response.status),
    };
  }

  const uid = extractBookingUid(result.data);
  if (!uid) {
    return { ok: false, error: 'Cal.com did not return a booking UID.' };
  }

  const confirmError = await confirmCalV2Booking(uid);
  if (confirmError) {
    await cancelCalTimeBlockBooking(uid).catch(() => undefined);
    return { ok: false, error: confirmError };
  }

  return { ok: true, uid };
}

export async function createCalTimeBlockBookings(args: {
  startIso: string;
  durationMinutes: number;
}): Promise<
  | {
      ok: true;
      uids: string[];
      calTotalMinutes: number;
      roundedUpMinutes: number;
    }
  | { ok: false; error: string }
> {
  const overrideEventTypeId = parseAdminOverrideEventId();
  if (overrideEventTypeId == null) {
    return {
      ok: false,
      error:
        'CAL_ADMIN_OVERRIDE_EVENT_ID is not configured — cannot block time on Cal.com.',
    };
  }

  const durationMinutes = Math.max(15, Math.round(args.durationMinutes));
  const plan = planCalTimeBlockSegments(durationMinutes);
  if ('error' in plan) {
    return { ok: false, error: plan.error };
  }

  let startUtc: Date;
  try {
    startUtc = parseBookingStartForCal(args.startIso);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const uids: string[] = [];
  let cursor = startUtc;

  for (const segmentMinutes of plan.segments) {
    const result = await createCalTimeBlockSegment({
      startUtc: cursor,
      durationMinutes: segmentMinutes,
      overrideEventTypeId,
    });

    if (!result.ok) {
      for (const uid of uids) {
        await cancelCalTimeBlockBooking(uid).catch(() => undefined);
      }
      return result;
    }

    uids.push(result.uid);
    cursor = new Date(cursor.getTime() + segmentMinutes * 60_000);
  }

  return {
    ok: true,
    uids,
    calTotalMinutes: plan.calTotalMinutes,
    roundedUpMinutes: plan.roundedUpMinutes,
  };
}

/** @deprecated Use createCalTimeBlockBookings — kept for call-site grep. */
export async function createCalTimeBlockBooking(args: {
  startIso: string;
  durationMinutes: number;
}): Promise<{ ok: true; uid: string } | { ok: false; error: string }> {
  const result = await createCalTimeBlockBookings(args);
  if (!result.ok) return result;
  return { ok: true, uid: result.uids[0] ?? '' };
}

export async function cancelCalTimeBlockBookings(
  bookingUids: string[]
): Promise<string | null> {
  const unique = [...new Set(bookingUids.filter(Boolean))];
  let lastError: string | null = null;
  for (const uid of unique) {
    const err = await cancelCalTimeBlockBooking(uid);
    if (err) lastError = err;
  }
  return lastError;
}

export async function cancelCalTimeBlockBooking(
  bookingUid: string
): Promise<string | null> {
  const apiKey =
    process.env.CALCOM_API_KEY?.trim() || process.env.CAL_API_KEY?.trim();
  if (!apiKey) {
    return 'Cal.com API key is not configured';
  }

  try {
    const upstream = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(bookingUid)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_BOOKINGS_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          cancellationReason: 'Admin removed time block',
        }),
      }
    );

    if (upstream.status === 404) return null;

    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => null);
      return calUpstreamErrorMessage(payload, upstream.status);
    }

    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
