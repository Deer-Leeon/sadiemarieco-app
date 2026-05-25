/**
 * Returns true when the proposed slot matches the appointment's existing
 * start (and end, when both sides have an end time).
 */
export function isSameAppointmentSlot(
  existingStart: string | Date | null | undefined,
  existingEnd: string | Date | null | undefined,
  newStart: string,
  newEnd: string | null | undefined
): boolean {
  const toMs = (value: string | Date | null | undefined): number | null => {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  const oldStartMs = toMs(existingStart);
  const newStartMs = toMs(newStart);
  if (oldStartMs == null || newStartMs == null) return false;
  if (oldStartMs !== newStartMs) return false;

  const oldEndMs = toMs(existingEnd);
  const newEndMs = toMs(newEnd);
  if (oldEndMs != null && newEndMs != null && oldEndMs !== newEndMs) {
    return false;
  }

  return true;
}

export const RESCHEDULE_SAME_SLOT_MESSAGE =
  'Please choose a different date or time. This appointment is already scheduled for that slot.';
