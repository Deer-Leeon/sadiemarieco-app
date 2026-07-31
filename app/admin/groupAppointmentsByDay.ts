import type { Appointment } from './types';
import {
  formatStudioDateShort,
  studioDateKey,
} from '@/lib/studio-calendar';

export interface AppointmentDayGroup {
  /** YYYY-MM-DD for valid dates, or `unscheduled` as a sentinel. */
  key: string;
  /** Display label, e.g. "Monday, May 25" or "Unscheduled". */
  label: string;
  appointments: Appointment[];
}

/**
 * Bucket appointments by America/Denver calendar day. Appointments within
 * each day sort ascending by start time. Day groups sort by `dayOrder`
 * (newest-first for past/history, soonest-first for upcoming).
 */
export function groupAppointmentsByDay(
  appointments: Appointment[],
  options?: { dayOrder?: 'asc' | 'desc' }
): AppointmentDayGroup[] {
  const dayOrder = options?.dayOrder ?? 'desc';
  const groups = new Map<string, AppointmentDayGroup>();

  for (const a of appointments) {
    if (!a.booking_time) {
      const k = 'unscheduled';
      if (!groups.has(k)) {
        groups.set(k, { key: k, label: 'Unscheduled', appointments: [] });
      }
      groups.get(k)!.appointments.push(a);
      continue;
    }
    const key = studioDateKey(a.booking_time);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: formatStudioDateShort(a.booking_time),
        appointments: [],
      });
    }
    groups.get(key)!.appointments.push(a);
  }

  for (const g of groups.values()) {
    g.appointments.sort((a, b) => {
      if (!a.booking_time) return 1;
      if (!b.booking_time) return -1;
      return (
        new Date(a.booking_time).getTime() - new Date(b.booking_time).getTime()
      );
    });
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.key === 'unscheduled') return 1;
    if (b.key === 'unscheduled') return -1;
    const cmp = b.key.localeCompare(a.key);
    return dayOrder === 'desc' ? cmp : -cmp;
  });
}
