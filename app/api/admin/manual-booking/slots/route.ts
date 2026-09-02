/**
 * GET /api/admin/manual-booking/slots
 *
 * Admin-only availability for the New booking picker.
 * Query: eventTypeId (number), date (YYYY-MM-DD), optional end (YYYY-MM-DD).
 *
 * When `CAL_ADMIN_OVERRIDE_EVENT_ID` is set, returns the full 9 AM–9 PM
 * start grid for the service length — including times that already have
 * an appointment — so staff can double-book. Occupied starts are listed
 * in `occupied` (ISO strings) for UI labeling; they stay selectable.
 * Create still sends `allowConflicts` to Cal.
 *
 * Public `/api/book/slots` stays occupancy-gated (Postgres busy + blocks).
 *
 * When the override env is unset, falls back to Cal.com `/slots` on the
 * real service event (busy times hidden).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import { adminGodModeSlotsForRange } from '@/lib/booking-duration';
import { addCalendarDays, inclusiveCalendarDayCount, MAX_SLOT_QUERY_DAYS } from '@/lib/cal-slot-dates';
import { parseBookingStartForCal } from '@/lib/cal-timezone';
import { loadStudioBusyIntervals } from '@/lib/studio-available-slots';
import {
  CAL_SLOTS_API_VERSION,
  gateAdmin,
  normalizeCalSlotsPayload,
  proxyCalV2Get,
} from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

async function occupiedStartsForSlots(
  slots: Record<string, string[]>,
  durationMins: number,
  rangeStartYmd: string,
  rangeEndYmd: string
): Promise<string[]> {
  const rangeStart = parseBookingStartForCal(`${rangeStartYmd}T00:00:00`);
  const rangeEnd = parseBookingStartForCal(
    `${addCalendarDays(rangeEndYmd, 1)}T00:00:00`
  );
  const busy = await loadStudioBusyIntervals(rangeStart, rangeEnd);
  if (busy.length === 0) return [];

  const durationMs = durationMins * 60_000;
  const occupied: string[] = [];
  const seen = new Set<number>();

  for (const times of Object.values(slots)) {
    for (const iso of times) {
      const startMs = new Date(iso).getTime();
      if (Number.isNaN(startMs) || seen.has(startMs)) continue;
      const endMs = startMs + durationMs;
      if (busy.some((b) => intervalsOverlap(startMs, endMs, b.startMs, b.endMs))) {
        seen.add(startMs);
        occupied.push(iso);
      }
    }
  }

  return occupied;
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

  const span = inclusiveCalendarDayCount(date, end);
  if (!Number.isFinite(span) || span > MAX_SLOT_QUERY_DAYS) {
    return NextResponse.json(
      {
        error: 'invalid_range',
        message: `date range cannot exceed ${MAX_SLOT_QUERY_DAYS} days`,
      },
      { status: 400 }
    );
  }

  const overrideEventTypeId = parseAdminOverrideEventId();
  const service = await loadServiceByCalEventId(eventTypeId);
  const serviceDurationMins = service?.duration_mins ?? null;
  const useGodModeGrid =
    overrideEventTypeId != null && serviceDurationMins != null;

  if (useGodModeGrid) {
    const slots = adminGodModeSlotsForRange(date, end, serviceDurationMins);
    let occupied: string[] = [];
    try {
      occupied = await occupiedStartsForSlots(
        slots,
        serviceDurationMins,
        date,
        end
      );
    } catch (err) {
      console.warn(
        '[api/admin/manual-booking/slots] occupied lookup failed (non-fatal)',
        { error: err instanceof Error ? err.message : String(err) }
      );
    }

    if (end === date) {
      return NextResponse.json({
        slots: { [date]: slots[date] ?? [] },
        occupied,
      });
    }
    return NextResponse.json({ slots, occupied });
  }

  const calEventTypeId = overrideEventTypeId ?? eventTypeId;
  // Cal buckets late Mountain Time under the next UTC date — extend by one day.
  const calRangeEnd = addCalendarDays(end, 1);

  const baseQuery: Record<string, string> = {
    eventTypeId: String(calEventTypeId),
    start: date,
    end: calRangeEnd,
    timeZone: STUDIO_TIMEZONE,
  };

  const normOpts = { studioDateStart: date, studioDateEnd: end };

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
