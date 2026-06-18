/**
 * Format Cal.com recurring weekly availability for the public contact page.
 * Date overrides are intentionally excluded — only constant weekly hours.
 */

import {
  DAY_INDICES,
  dayIndexFromName,
  type DayIndex,
  type HHMM,
  type ScheduleAvailability,
} from '@/app/admin/availability/calSchedules';

const DAY_LABELS: Record<DayIndex, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/** Matches the contact section copy: `9 am`, `12:45 pm`, `9 pm`. */
export function formatPublicTime(time: HHMM): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return time;

  const hour24 = Number(match[1]);
  const minute = Number(match[2]);
  const period = hour24 >= 12 ? 'pm' : 'am';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  if (minute === 0) return `${hour12} ${period}`;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

/**
 * Collapse Cal's `{ days: [Mon, Wed], start, end }` blocks into one
 * window per weekday — same first-write-wins rule as the admin editor.
 */
function weeklyWindowsByDay(
  availability: ScheduleAvailability[]
): Map<DayIndex, { startTime: HHMM; endTime: HHMM }> {
  const out = new Map<DayIndex, { startTime: HHMM; endTime: HHMM }>();

  for (const block of availability) {
    for (const day of block.days) {
      const idx = dayIndexFromName(day);
      if (!out.has(idx)) {
        out.set(idx, {
          startTime: block.startTime,
          endTime: block.endTime,
        });
      }
    }
  }

  return out;
}

/** HTML lines for the contact Hours block (`<br>` separated). */
export function renderWeeklyHoursHtml(
  availability: ScheduleAvailability[]
): string {
  const byDay = weeklyWindowsByDay(availability);
  const lines: string[] = [];

  for (const idx of DAY_INDICES) {
    const window = byDay.get(idx);
    if (!window) continue;

    const day = DAY_LABELS[idx];
    const start = formatPublicTime(window.startTime);
    const end = formatPublicTime(window.endTime);
    lines.push(`${day}: ${start} &ndash; ${end}`);
  }

  if (lines.length === 0) {
    return 'By appointment';
  }

  return lines.join('<br>');
}
