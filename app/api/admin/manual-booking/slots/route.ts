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
 * God-mode grid:
 *   1. Fine probe (`duration=15`) — quarter-hour open windows.
 *   2. Coarse probe (`duration=service`) — Cal-validated full-block starts.
 *   3. Merge both so long services still show morning starts when buffers
 *      drop a single 15-min step (e.g. 11:45 before a noon appointment).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN,
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import {
  mergeSlotDays,
  slotStartsFromFineGrid,
} from '@/lib/booking-duration';
import { addCalendarDays } from '@/lib/cal-slot-dates';
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

function buildGodModeSlots(
  finePayload: unknown,
  coarsePayload: unknown,
  serviceDurationMins: number,
  studioDateStart: string,
  studioDateEnd: string
): { slots: Record<string, string[]> } {
  const normOpts = { studioDateStart, studioDateEnd };
  const fine = normalizeCalSlotsPayload(finePayload, normOpts);
  const coarse = normalizeCalSlotsPayload(coarsePayload, normOpts);
  const fromFine = slotStartsFromFineGrid(
    fine.slots,
    serviceDurationMins,
    ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN
  );

  return { slots: mergeSlotDays(fromFine, coarse.slots) };
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
  const useGodModeGrid =
    overrideEventTypeId != null && serviceDurationMins != null;

  // Cal buckets late Mountain Time under the next UTC date — extend by one day.
  const calRangeEnd = addCalendarDays(end, 1);

  const baseQuery: Record<string, string> = {
    eventTypeId: String(calEventTypeId),
    start: date,
    end: calRangeEnd,
    timeZone: STUDIO_TIMEZONE,
  };

  const normOpts = { studioDateStart: date, studioDateEnd: end };

  if (useGodModeGrid) {
    const [fineResult, coarseResult] = await Promise.all([
      proxyCalV2Get(
        '/slots',
        {
          ...baseQuery,
          duration: String(ADMIN_MANUAL_BOOKING_SLOT_INTERVAL_MIN),
        },
        CAL_SLOTS_API_VERSION
      ),
      proxyCalV2Get(
        '/slots',
        {
          ...baseQuery,
          duration: String(serviceDurationMins),
        },
        CAL_SLOTS_API_VERSION
      ),
    ]);

    if (!fineResult.ok) return fineResult.response;
    if (!coarseResult.ok) return coarseResult.response;

    const merged = buildGodModeSlots(
      fineResult.data,
      coarseResult.data,
      serviceDurationMins,
      date,
      end
    );

    if (end === date) {
      return NextResponse.json({
        slots: { [date]: merged.slots[date] ?? [] },
      });
    }
    return NextResponse.json(merged);
  }

  const slotQuery = { ...baseQuery };
  if (serviceDurationMins) {
    slotQuery.duration = String(serviceDurationMins);
  }

  const result = await proxyCalV2Get(
    '/slots',
    slotQuery,
    CAL_SLOTS_API_VERSION
  );

  if (!result.ok) return result.response;

  if (end === date) {
    const normalized = normalizeCalSlotsPayload(result.data, normOpts);
    return NextResponse.json({
      slots: { [date]: normalized.slots[date] ?? [] },
    });
  }
  return NextResponse.json(normalizeCalSlotsPayload(result.data, normOpts));
}
