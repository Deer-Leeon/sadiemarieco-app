/**
 * /api/admin/availability
 *
 * Browser-side proxy for the studio's Cal.com /schedules surface.
 * Lives between AvailabilityClient.tsx (which can't see CAL_API_KEY)
 * and the Cal.com v2 API.
 *
 * The Server Component at /admin/availability/page.tsx does NOT route
 * its initial fetch through here — it imports the shared helpers
 * directly from app/admin/availability/calSchedules so the page paints
 * with one Cal round-trip instead of three (page → proxy → Cal). The
 * proxy exists for client-side mutations (PATCH on save) and for any
 * future client-side refetch we might add (e.g. polling after a Cal-
 * dashboard edit).
 *
 * Auth: both verbs require an allowlisted admin (see app/admin/auth.ts).
 * The handler short-circuits with 401 / 403 before touching Cal so a
 * leaked CAL_API_KEY is never the only line of defence.
 *
 * v1 spec compatibility:
 *   The original spec for this feature referenced Cal.com v1 endpoints
 *   (`/v1/schedules`, integer day values, "empty times array" for
 *   blocked overrides). v1 was decommissioned May 2026 — see the same
 *   note in app/api/admin/services/route.ts. This file implements the
 *   v2 equivalents and shapes the responses so the client can keep
 *   speaking the integer-day vocabulary the original spec implied.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  fetchDefaultSchedule,
  updateSchedule,
  type DayName,
  type ScheduleAvailability,
  type ScheduleOverride,
} from '@/app/admin/availability/calSchedules';

export const dynamic = 'force-dynamic';

// Wire-format validators. Stricter than Cal.com's own checks so a
// malformed admin payload trips a clean 400 here instead of a
// less-readable 422 bubbling up from Cal.
const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_DAY_NAMES: ReadonlySet<DayName> = new Set([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

// ─── HANDLERS ──────────────────────────────────────────────────────────────

/**
 * GET → returns the studio's current default schedule shape:
 *   { id, name, timeZone, availability[], overrides[] }
 *
 * The id is what the client must echo back on PATCH (Cal requires
 * scheduleId in the URL path); we expose it explicitly rather than
 * making the client guess from the route or fetch /schedules itself.
 */
export async function GET(): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/admin/availability] GET: CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 }
    );
  }

  try {
    const schedule = await fetchDefaultSchedule(apiKey);
    return NextResponse.json({
      id: schedule.id,
      name: schedule.name,
      timeZone: schedule.timeZone,
      availability: schedule.availability,
      overrides: schedule.overrides,
    });
  } catch (err) {
    console.error('[api/admin/availability] GET: Cal fetch failed:', err);
    return NextResponse.json(
      { error: 'cal_fetch_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }
}

/**
 * PATCH body shape:
 *   { scheduleId: number,
 *     availability: { days: DayName[], startTime: "HH:MM", endTime: "HH:MM" }[],
 *     overrides:    { date: "YYYY-MM-DD", startTime: "HH:MM", endTime: "HH:MM" }[] }
 *
 * Blocked overrides come over the wire as startTime === endTime ===
 * "00:00" — the same convention Cal's dashboard uses and the only way
 * to encode "no availability" given v2's required-times constraint.
 *
 * The handler validates the entire payload before calling Cal so a
 * single bad row aborts the whole write — we never PATCH a partial
 * schedule into Cal that the editor would then have to clean up.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/admin/availability] PATCH: CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 }
    );
  }

  let body: PatchPayload;
  try {
    body = parsePatchBody(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_payload', message: errorMessage(err) },
      { status: 400 }
    );
  }

  try {
    const updated = await updateSchedule(apiKey, body.scheduleId, {
      availability: body.availability,
      overrides: body.overrides,
    });
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      timeZone: updated.timeZone,
      availability: updated.availability,
      overrides: updated.overrides,
    });
  } catch (err) {
    console.error('[api/admin/availability] PATCH: Cal update failed:', err);
    return NextResponse.json(
      { error: 'cal_update_failed', message: errorMessage(err) },
      { status: 502 }
    );
  }
}

// ─── PARSING ───────────────────────────────────────────────────────────────

interface PatchPayload {
  scheduleId: number;
  availability: ScheduleAvailability[];
  overrides: ScheduleOverride[];
}

function parsePatchBody(input: unknown): PatchPayload {
  if (!isRecord(input)) {
    throw new Error('Body must be a JSON object.');
  }
  const scheduleId = input.scheduleId;
  if (
    typeof scheduleId !== 'number' ||
    !Number.isInteger(scheduleId) ||
    scheduleId < 1
  ) {
    throw new Error('scheduleId must be a positive integer.');
  }
  return {
    scheduleId,
    availability: parseAvailability(input.availability),
    overrides: parseOverrides(input.overrides),
  };
}

function parseAvailability(value: unknown): ScheduleAvailability[] {
  if (!Array.isArray(value)) {
    throw new Error('availability must be an array.');
  }
  return value.map((raw, i) => {
    if (!isRecord(raw)) {
      throw new Error(`availability[${i}] must be an object.`);
    }
    const days = Array.isArray(raw.days) ? raw.days : null;
    if (!days || days.length === 0) {
      throw new Error(
        `availability[${i}].days must be a non-empty string array.`
      );
    }
    for (const d of days) {
      if (typeof d !== 'string' || !VALID_DAY_NAMES.has(d as DayName)) {
        throw new Error(
          `availability[${i}].days has invalid value "${String(d)}". Expected one of: Sunday … Saturday.`
        );
      }
    }
    const startTime = raw.startTime;
    const endTime = raw.endTime;
    if (typeof startTime !== 'string' || !HH_MM_RE.test(startTime)) {
      throw new Error(`availability[${i}].startTime must be HH:MM (24-hour).`);
    }
    if (typeof endTime !== 'string' || !HH_MM_RE.test(endTime)) {
      throw new Error(`availability[${i}].endTime must be HH:MM (24-hour).`);
    }
    // Lexical comparison works for HH:MM 24-hour strings — "23:00" >
    // "09:00" character by character, same as numerically. We forbid
    // equal times here because a zero-minute recurring block is
    // meaningless and would silently produce no bookable slots.
    if (startTime >= endTime) {
      throw new Error(
        `availability[${i}] startTime "${startTime}" must be earlier than endTime "${endTime}".`
      );
    }
    return {
      days: days as DayName[],
      startTime,
      endTime,
    };
  });
}

function parseOverrides(value: unknown): ScheduleOverride[] {
  if (!Array.isArray(value)) {
    throw new Error('overrides must be an array.');
  }
  return value.map((raw, i) => {
    if (!isRecord(raw)) {
      throw new Error(`overrides[${i}] must be an object.`);
    }
    const date = raw.date;
    if (typeof date !== 'string' || !ISO_DATE_RE.test(date)) {
      throw new Error(`overrides[${i}].date must be YYYY-MM-DD.`);
    }
    const startTime = raw.startTime;
    const endTime = raw.endTime;
    if (typeof startTime !== 'string' || !HH_MM_RE.test(startTime)) {
      throw new Error(`overrides[${i}].startTime must be HH:MM (24-hour).`);
    }
    if (typeof endTime !== 'string' || !HH_MM_RE.test(endTime)) {
      throw new Error(`overrides[${i}].endTime must be HH:MM (24-hour).`);
    }
    // Overrides allow startTime === endTime — that's the "unavailable
    // all day" sentinel ("00:00"/"00:00"). Reject only when start is
    // strictly greater than end (i.e. truly inverted).
    if (startTime > endTime) {
      throw new Error(
        `overrides[${i}] startTime "${startTime}" must be ≤ endTime "${endTime}". Use equal times to mark "unavailable all day".`
      );
    }
    return { date, startTime, endTime };
  });
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

async function gateAdmin(): Promise<NextResponse | null> {
  const access = await requireAdminUser();
  if (access.ok) return null;
  return NextResponse.json(
    { error: access.reason },
    { status: access.reason === 'unauthenticated' ? 401 : 403 }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
