import 'server-only';

import { sql } from '@vercel/postgres';

import { syncAttachedExtrasTimes } from '@/lib/appointment-attached';
import { scheduleReviewRequestSms } from '@/lib/booking-notifications';
import {
  CHAIR_DURATION_MIN_MIN,
  displayedChairDurationMins,
  endIsoFromDuration,
  snapChairDurationMins,
} from '@/lib/chair-duration';

let ensureSchemaPromise: Promise<void> | null = null;

export async function ensureChairDurationSchema(): Promise<void> {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await sql.query(`
        ALTER TABLE appointments
          ADD COLUMN IF NOT EXISTS chair_duration_mins INTEGER NULL
      `);
    })().catch((err) => {
      ensureSchemaPromise = null;
      throw err;
    });
  }
  await ensureSchemaPromise;
}

export async function loadCatalogueDurationMins(
  calEventTypeId: number | null | undefined
): Promise<number | null> {
  if (calEventTypeId == null || !Number.isInteger(calEventTypeId) || calEventTypeId <= 0) {
    return null;
  }
  const { rows } = await sql<{ duration_mins: number | null }>`
    SELECT duration_mins
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND cal_event_id = ${calEventTypeId}
    ORDER BY display_order ASC, id ASC
    LIMIT 1
  `;
  const raw = rows[0]?.duration_mins;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function preserveChairEndTime(args: {
  startIso: string | null;
  fallbackEndIso: string | null;
  chairDurationMins: number | null | undefined;
}): string | null {
  if (
    args.startIso &&
    typeof args.chairDurationMins === 'number' &&
    Number.isFinite(args.chairDurationMins) &&
    args.chairDurationMins > 0
  ) {
    return (
      endIsoFromDuration(args.startIso, args.chairDurationMins) ??
      args.fallbackEndIso
    );
  }
  return args.fallbackEndIso;
}

export async function loadChairDurationMinsForCalUid(
  calUid: string | null | undefined
): Promise<number | null> {
  if (!calUid) return null;
  await ensureChairDurationSchema();
  try {
    const { rows } = await sql<{ chair_duration_mins: number | null }>`
      SELECT chair_duration_mins
      FROM appointments
      WHERE cal_event_id = ${calUid}
      LIMIT 1
    `;
    const raw = rows[0]?.chair_duration_mins;
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface AppliedChairDuration {
  bookingTime: string | null;
  endTime: string | null;
  chairDurationMins: number;
}

async function loadParentForChair(parentId: string): Promise<{
  id: string;
  cal_event_id: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  chair_duration_mins: number | null;
  attached_to_appointment_id: string | null;
  status: string | null;
} | null> {
  await ensureChairDurationSchema();
  const { rows } = await sql<{
    id: string;
    cal_event_id: string | null;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    chair_duration_mins: number | null;
    attached_to_appointment_id: string | null;
    status: string | null;
  }>`
    SELECT
      id::text AS id,
      cal_event_id,
      booking_time,
      end_time,
      chair_duration_mins,
      attached_to_appointment_id::text AS attached_to_appointment_id,
      status
    FROM appointments
    WHERE id::text = ${parentId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function writeChairDuration(args: {
  parentId: string;
  bookingTime: string;
  durationMins: number;
  calEventId: string | null;
}): Promise<AppliedChairDuration> {
  const durationMins = snapChairDurationMins(args.durationMins);
  const endTime = endIsoFromDuration(args.bookingTime, durationMins);
  if (!endTime) {
    throw new Error('Could not compute a visit end time.');
  }

  await sql`
    UPDATE appointments
    SET chair_duration_mins = ${durationMins},
        end_time = ${endTime}
    WHERE id::text = ${args.parentId}
  `;
  await syncAttachedExtrasTimes(args.parentId, args.bookingTime, endTime);

  if (args.calEventId) {
    try {
      await scheduleReviewRequestSms(args.calEventId, {
        bookingTime: args.bookingTime,
        endTime,
        force: true,
      });
    } catch (err) {
      console.warn('[visit-duration] review SMS re-queue failed', {
        parentId: args.parentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    bookingTime: args.bookingTime,
    endTime,
    chairDurationMins: durationMins,
  };
}

function isoFromSql(value: Date | string | null): string | null {
  if (!value) return null;
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function assertParentVisit(parent: {
  attached_to_appointment_id: string | null;
  status: string | null;
}): void {
  if (parent.attached_to_appointment_id) {
    throw Object.assign(new Error('not_a_visit'), { code: 'not_a_visit' });
  }
  const status = (parent.status || '').toLowerCase();
  if (status !== 'confirmed') {
    throw Object.assign(new Error('parent_not_attachable'), {
      code: 'parent_not_attachable',
    });
  }
}

export async function applyChairDuration(args: {
  parentId: string;
  durationMins: number;
}): Promise<AppliedChairDuration> {
  const parent = await loadParentForChair(args.parentId);
  if (!parent) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  assertParentVisit(parent);
  const bookingTime = isoFromSql(parent.booking_time);
  if (!bookingTime) {
    throw Object.assign(new Error('missing_booking_time'), {
      code: 'missing_booking_time',
    });
  }
  return writeChairDuration({
    parentId: parent.id,
    bookingTime,
    durationMins: args.durationMins,
    calEventId: parent.cal_event_id,
  });
}

export async function adjustChairDurationBy(args: {
  parentId: string;
  deltaMins: number;
}): Promise<AppliedChairDuration> {
  const parent = await loadParentForChair(args.parentId);
  if (!parent) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  assertParentVisit(parent);
  const current = displayedChairDurationMins({
    chair_duration_mins: parent.chair_duration_mins,
    booking_time: parent.booking_time,
    end_time: parent.end_time,
  });
  const next = Math.max(CHAIR_DURATION_MIN_MIN, current + args.deltaMins);
  const bookingTime = isoFromSql(parent.booking_time);
  if (!bookingTime) {
    throw Object.assign(new Error('missing_booking_time'), {
      code: 'missing_booking_time',
    });
  }
  return writeChairDuration({
    parentId: parent.id,
    bookingTime,
    durationMins: next,
    calEventId: parent.cal_event_id,
  });
}
