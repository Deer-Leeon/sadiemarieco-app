/**
 * Client-safe chair-duration math. Server writes live in `visit-duration.ts`.
 */

export const CHAIR_DURATION_STEP_MIN = 15;
export const CHAIR_DURATION_MIN_MIN = 15;
export const CHAIR_DURATION_MAX_MIN = 720;

export function snapChairDurationMins(raw: number): number {
  if (!Number.isFinite(raw)) return CHAIR_DURATION_MIN_MIN;
  const stepped =
    Math.round(raw / CHAIR_DURATION_STEP_MIN) * CHAIR_DURATION_STEP_MIN;
  return Math.min(
    CHAIR_DURATION_MAX_MIN,
    Math.max(CHAIR_DURATION_MIN_MIN, stepped)
  );
}

export function minutesBetween(
  startIso: string | Date | null | undefined,
  endIso: string | Date | null | undefined
): number | null {
  if (!startIso || !endIso) return null;
  const start = startIso instanceof Date ? startIso : new Date(startIso);
  const end = endIso instanceof Date ? endIso : new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
  return mins > 0 ? mins : null;
}

export function endIsoFromDuration(
  startIso: string | Date | null | undefined,
  durationMins: number
): string | null {
  if (!startIso || !Number.isFinite(durationMins) || durationMins <= 0) {
    return null;
  }
  const start = startIso instanceof Date ? startIso : new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + durationMins * 60_000).toISOString();
}

/** "45 min" / "1 hr" / "1 hr 45 min" */
export function formatChairDurationLabel(mins: number): string {
  const safe = Math.max(0, Math.round(mins));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours <= 0) return `${rest} min`;
  if (rest === 0) return hours === 1 ? '1 hr' : `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

export function displayedChairDurationMins(input: {
  chair_duration_mins?: number | null;
  booking_time?: string | Date | null;
  end_time?: string | Date | null;
}): number {
  if (
    typeof input.chair_duration_mins === 'number' &&
    Number.isFinite(input.chair_duration_mins) &&
    input.chair_duration_mins > 0
  ) {
    return snapChairDurationMins(input.chair_duration_mins);
  }
  return (
    minutesBetween(input.booking_time, input.end_time) ??
    CHAIR_DURATION_STEP_MIN
  );
}
