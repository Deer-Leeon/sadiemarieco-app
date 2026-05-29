/**
 * GET /api/admin/manual-booking/slots
 *
 * Admin-only proxy for Cal.com v2 available slots.
 * Query: eventTypeId (number), date (YYYY-MM-DD), optional end (YYYY-MM-DD).
 * When `end` is provided and differs from `date`, returns all days in the range.
 *
 * When `CAL_ADMIN_OVERRIDE_EVENT_ID` is set, proxies slots for that shadow
 * event type (9 AM–9 PM) while the client still sends the real service id.
 *
 * God-mode slot grid: requests `duration=15` on the shadow event type (Cal uses
 * the event type's configured interval — do not pass `slotInterval`; v2 rejects
 * it), then post-filters to starts where the full service duration fits.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN,
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import {
  filterSlotStartsForServiceDuration,
} from '@/lib/booking-duration';
import {
  CAL_SLOTS_API_VERSION,
  gateAdmin,
  normalizeCalSlotsForDate,
  normalizeCalSlotsPayload,
  proxyCalV2Get,
} from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function applyGodModeSlotFilter(
  payload: { slots: Record<string, string[]> },
  serviceDurationMins: number
): { slots: Record<string, string[]> } {
  return {
    slots: filterSlotStartsForServiceDuration(
      payload.slots,
      serviceDurationMins,
      ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN
    ),
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const eventTypeIdRaw = req.nextUrl.searchParams.get('eventTypeId');
  const date = req.nextUrl.searchParams.get('date')?.trim() ?? '';
  const end = req.nextUrl.searchParams.get('end')?.trim() ?? date;

  const eventTypeId = eventTypeIdRaw ? Number(eventTypeIdRaw) : NaN;
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return NextResponse.json(
      { error: 'invalid_event_type_id', message: 'eventTypeId must be a positive integer' },
      { status: 400 }
    );
  }

  if (!ISO_DATE_RE.test(date)) {
    return NextResponse.json(
      { error: 'invalid_date', message: 'date must be YYYY-MM-DD' },
      { status: 400 }
    );
  }

  if (!ISO_DATE_RE.test(end)) {
    return NextResponse.json(
      { error: 'invalid_end', message: 'end must be YYYY-MM-DD' },
      { status: 400 }
    );
  }

  if (end < date) {
    return NextResponse.json(
      { error: 'invalid_range', message: 'end must be on or after date' },
      { status: 400 }
    );
  }

  const overrideEventTypeId = parseAdminOverrideEventId();
  const calEventTypeId = overrideEventTypeId ?? eventTypeId;
  const service = await loadServiceByCalEventId(eventTypeId);
  const serviceDurationMins = service?.duration_mins ?? null;
  const useGodModeGrid = overrideEventTypeId != null;

  const slotQuery: Record<string, string> = {
    eventTypeId: String(calEventTypeId),
    start: date,
    end,
    timeZone: STUDIO_TIMEZONE,
  };

  if (useGodModeGrid) {
    // Probe at quarter-hour blocks; filter below for full service length.
    slotQuery.duration = String(ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN);
  } else if (serviceDurationMins) {
    slotQuery.duration = String(serviceDurationMins);
  }

  const result = await proxyCalV2Get(
    '/slots',
    slotQuery,
    CAL_SLOTS_API_VERSION
  );

  if (!result.ok) return result.response;

  if (end === date) {
    let normalized = normalizeCalSlotsForDate(result.data, date);
    if (useGodModeGrid && serviceDurationMins) {
      normalized = applyGodModeSlotFilter(normalized, serviceDurationMins);
    }
    return NextResponse.json(normalized);
  }

  let normalized = normalizeCalSlotsPayload(result.data);
  if (useGodModeGrid && serviceDurationMins) {
    normalized = applyGodModeSlotFilter(normalized, serviceDurationMins);
  }
  return NextResponse.json(normalized);
}
