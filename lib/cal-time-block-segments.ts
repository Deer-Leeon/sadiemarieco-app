/**
 * Split an arbitrary block length into consecutive Cal.com booking segments
 * whose durations are each allowed on the admin override event type.
 */

import { CAL_ADMIN_OVERRIDE_BLOCK_DURATIONS_MIN } from '@/lib/cal-config';

export interface BlockSegmentPlan {
  /** Consecutive Cal booking lengths (minutes) that sum to `calTotalMinutes`. */
  segments: number[];
  /** Total minutes covered on Cal (may round up slightly vs the requested span). */
  calTotalMinutes: number;
  /** Extra minutes added vs the requested duration (0 when exact). */
  roundedUpMinutes: number;
}

/**
 * Fewest-segment exact partition via DP, then optional round-up to the next
 * achievable total so Cal always fully covers the requested window.
 */
export function planCalTimeBlockSegments(
  requestedMinutes: number,
  allowed: readonly number[] = CAL_ADMIN_OVERRIDE_BLOCK_DURATIONS_MIN
): BlockSegmentPlan | { error: string } {
  const sorted = [...allowed].sort((a, b) => a - b);
  const min = sorted[0];
  const maxAllowed = sorted[sorted.length - 1];

  if (!Number.isFinite(requestedMinutes) || requestedMinutes < min) {
    return {
      error: `Blocks must be at least ${min} minutes for Cal.com.`,
    };
  }

  const total = Math.round(requestedMinutes);
  const maxTotal = total + maxAllowed;
  const dp: (number[] | null)[] = Array(maxTotal + 1).fill(null);
  dp[0] = [];

  for (let t = 1; t <= maxTotal; t++) {
    for (const d of sorted) {
      if (t >= d && dp[t - d] !== null) {
        const candidate = [...dp[t - d]!, d];
        if (!dp[t] || candidate.length < dp[t]!.length) {
          dp[t] = candidate;
        }
      }
    }
  }

  let chosenTotal = total;
  if (!dp[total]) {
    for (let t = total + 1; t <= maxTotal; t++) {
      if (dp[t]) {
        chosenTotal = t;
        break;
      }
    }
    if (!dp[chosenTotal]) {
      return {
        error:
          'Could not map this block length to Cal.com durations. Try adjusting by a few minutes.',
      };
    }
  }

  const segments = dp[chosenTotal]!;
  return {
    segments,
    calTotalMinutes: chosenTotal,
    roundedUpMinutes: chosenTotal - total,
  };
}

export function allCalBookingUids(block: {
  cal_booking_uid: string | null;
  cal_booking_uids?: string[] | null;
}): string[] {
  const fromArray = Array.isArray(block.cal_booking_uids)
    ? block.cal_booking_uids.filter(
        (uid): uid is string => typeof uid === 'string' && uid.length > 0
      )
    : [];
  if (fromArray.length > 0) return fromArray;
  if (block.cal_booking_uid) return [block.cal_booking_uid];
  return [];
}
