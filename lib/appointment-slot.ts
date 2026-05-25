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

/** Short line for API responses and client-side toasts. */
export const RESCHEDULE_SAME_SLOT_MESSAGE =
  "You're already booked for this time. Choose a different date or time to move your appointment.";

/** Admin reschedule overlay — warmer, studio-toned copy. */
export function rescheduleSameSlotNotice(currentSlotLabel: string): {
  title: string;
  body: string;
} {
  return {
    title: 'This is already your appointment time',
    body: `Your booking is set for ${currentSlotLabel}. To reschedule, pick a different date or time in the calendar, then confirm your new slot.`,
  };
}
