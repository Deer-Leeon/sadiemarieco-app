/**
 * Shared gates for QStash reminder / feedback SMS handlers.
 */

function isSmsOptInTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === 'true' || s === 't' || s === '1' || s === 'yes';
  }
  return false;
}

const DEFAULT_TIME_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * True when the scheduled job still matches the appointment clock.
 * Cal / Postgres often differ by milliseconds or offset notation;
 * a strict `!==` dropped every reminder after an admin booking.
 * Unparseable values fail open so a clock-format quirk cannot silence SMS.
 */
function bookingTimesMatch(expectedIso, actual, toleranceMs = DEFAULT_TIME_TOLERANCE_MS) {
  if (!expectedIso || !actual) return true;
  const expectedMs = Date.parse(String(expectedIso));
  const actualMs =
    actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
  if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs)) return true;
  return Math.abs(expectedMs - actualMs) <= toleranceMs;
}

module.exports = {
  isSmsOptInTruthy,
  bookingTimesMatch,
  DEFAULT_TIME_TOLERANCE_MS,
};
