import type { Appointment, TimeBlock } from './types';
import { clientDisplayName, isAppointmentCanceled } from './helpers';
import { allCalBookingUids } from '@/lib/cal-time-block-segments';

/** Cal shadow bookings for time blocks must never render as client appointments. */
export function isIngestedTimeBlockAppointment(
  appointment: Appointment,
  timeBlockCalUids: ReadonlySet<string>
): boolean {
  if (appointment.cal_uid && timeBlockCalUids.has(appointment.cal_uid)) {
    return true;
  }

  const name = clientDisplayName(
    appointment.client_first_name,
    appointment.client_last_name
  )
    .trim()
    .toLowerCase();
  const service = (appointment.service_name || '').toLowerCase();

  return name === 'studio block' && service.includes('admin manual booking');
}

export function timeBlockCalUidSet(blocks: TimeBlock[]): Set<string> {
  const uids = new Set<string>();
  for (const block of blocks) {
    for (const uid of allCalBookingUids(block)) {
      uids.add(uid);
    }
  }
  return uids;
}

/**
 * Older blocks may only exist as ingested Cal shadow bookings in
 * `appointments` (before the webhook skip shipped). Surface them as
 * blocks so the grid + delete flow stay consistent.
 */
export function mergeGhostTimeBlocks(
  blocks: TimeBlock[],
  appointments: Appointment[]
): TimeBlock[] {
  const merged = [...blocks];
  const coveredUids = timeBlockCalUidSet(merged);

  for (const apt of appointments) {
    if (isAppointmentCanceled(apt.status)) continue;

    // Segment already covered by a studio_time_blocks row — do not
    // render a second pill from the shadow appointment mirror.
    if (apt.cal_uid && coveredUids.has(apt.cal_uid)) continue;

    if (!isIngestedTimeBlockAppointment(apt, new Set())) continue;
    if (!apt.booking_time || !apt.end_time) continue;

    merged.push({
      id: apt.id,
      start_time: apt.booking_time,
      end_time: apt.end_time,
      note: null,
      cal_booking_uid: apt.cal_uid,
    });
    if (apt.cal_uid) coveredUids.add(apt.cal_uid);
  }

  return coalesceTimeBlocksForDisplay(dedupeTimeBlocks(merged)).sort(
    (a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );
}

/** Prefer one row per Cal UID / identical interval (ghost + mirror duplicates). */
function dedupeTimeBlocks(blocks: TimeBlock[]): TimeBlock[] {
  const byKey = new Map<string, TimeBlock>();
  for (const block of blocks) {
    for (const uid of allCalBookingUids(block)) {
      if (!byKey.has(`uid:${uid}`)) byKey.set(`uid:${uid}`, block);
    }
    const intervalKey = `${block.start_time}|${block.end_time}`;
    if (!byKey.has(intervalKey)) byKey.set(intervalKey, block);
  }
  return [...new Set(byKey.values())];
}

const COALESCE_GAP_MS = 60_000;

/** Merge back-to-back duplicate pills into one labelled interval. */
export function coalesceTimeBlocksForDisplay(
  blocks: TimeBlock[]
): TimeBlock[] {
  const sorted = [...blocks].sort(
    (a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );
  const merged: TimeBlock[] = [];

  for (const block of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && shouldCoalesceBlocks(prev, block)) {
      const prevEnd = new Date(prev.end_time).getTime();
      const blockEnd = new Date(block.end_time).getTime();
      prev.end_time = new Date(Math.max(prevEnd, blockEnd)).toISOString();

      const uids = new Set([
        ...allCalBookingUids(prev),
        ...allCalBookingUids(block),
      ]);
      prev.cal_booking_uids = [...uids];
      prev.cal_booking_uid = prev.cal_booking_uid ?? block.cal_booking_uid;
      if (block.note && !prev.note) prev.note = block.note;
      continue;
    }
    merged.push({
      ...block,
      cal_booking_uids: allCalBookingUids(block),
    });
  }

  return merged;
}

function shouldCoalesceBlocks(a: TimeBlock, b: TimeBlock): boolean {
  const aEnd = new Date(a.end_time).getTime();
  const bStart = new Date(b.start_time).getTime();
  const bEnd = new Date(b.end_time).getTime();
  const aStart = new Date(a.start_time).getTime();

  const overlaps = bStart < aEnd && bEnd > aStart;
  if (overlaps) return true;

  const touches = Math.abs(bStart - aEnd) <= COALESCE_GAP_MS;
  if (!touches) return false;

  const sameNote = (a.note || '') === (b.note || '');
  return sameNote || (!a.note && !b.note);
}

export async function deleteTimeBlock(
  blockId: string
): Promise<
  { ok: true; warning?: string } | { ok: false; message: string }
> {
  const res = await fetch(`/api/admin/time-blocks/${blockId}`, {
    method: 'DELETE',
  });
  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    cal_cancel_error?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      message:
        typeof data.message === 'string'
          ? data.message
          : 'Could not remove the time block.',
    };
  }
  if (data.cal_cancel_error) {
    return { ok: true, warning: data.cal_cancel_error };
  }
  return { ok: true };
}
