/**
 * Service → colour mapping for appointment chrome across the admin
 * dashboard (list view, 3-day / week time grid, month grid, single-
 * day modal, client-profile history). Surfaced as a subtle 4px left
 * accent + a low-opacity background tint so the studio can scan the
 * schedule by service type without the colour overpowering the
 * neutral editorial aesthetic.
 *
 * Match strategy:
 *   1. The Cal.com event-type slug (`appointment.service_slug`) is
 *      the authoritative identifier — it's unique per service and
 *      already disambiguates the otherwise-ambiguous fill children
 *      ("Classic" exists under 2 Week / 3 Week / 4 Week Fill groups
 *      with identical titles but distinct slugs).
 *   2. The cleaned service title is the fallback when the slug is
 *      missing (legacy bookings predating the LEFT JOIN to
 *      site_services, or services renamed after the booking landed).
 *
 * Matching is done against a lower-cased haystack of both signals
 * concatenated; substring checks are ordered MOST SPECIFIC FIRST so
 * "Hybrid Full Set" hits the FULL_SET bucket before any of the bare
 * "Hybrid" / "Classic" children get a chance to be misclassified.
 *
 * Returning `null` is the documented fall-through for any service
 * the studio hasn't colour-coded yet (e.g. a brand-new offering the
 * editor added in /admin/services). Callers render the unchanged
 * neutral chrome in that case rather than picking a "default" colour
 * — silence beats guessing wrong.
 */

export interface ServiceColor {
  /** Solid hex used for the visible left accent border. */
  accent: string;
  /** Very light translucent background tint for the row/pill body. */
  tint: string;
  /** Mid-strength translucent border for compact pills where the
   *  accent border isn't legible (e.g. month-grid one-liners). */
  border: string;
}

/**
 * Build a {@link ServiceColor} from a single source-of-truth hex.
 * Tint sits at ~14% opacity — enough to read the service category at
 * a glance, faint enough that the row still reads as "white-ish" in
 * the surrounding neutral palette. Border lands at ~40% so the pill
 * edges don't blur into the canvas.
 */
function makeColor(hex: string): ServiceColor {
  const { r, g, b } = hexToRgb(hex);
  return {
    accent: hex,
    tint: `rgba(${r}, ${g}, ${b}, 0.14)`,
    border: `rgba(${r}, ${g}, ${b}, 0.4)`,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/**
 * Canonical service palette. Hex values are the spec the studio
 * owner picked; the runtime derives the tint/border from them so
 * touching a colour only needs a single edit here.
 */
export const SERVICE_COLORS = {
  FULL_SET: makeColor('#FE036A'),
  FIRST_TIME_FILL: makeColor('#F5347F'),
  FOUR_WEEK_FILL: makeColor('#F58D93'),
  THREE_WEEK_FILL: makeColor('#F99DBC'),
  TWO_WEEK_FILL: makeColor('#FEC2D6'),
  KOREAN_LIFT: makeColor('#8FD9FB'),
  LAM_TINT_WAX: makeColor('#5DAE5D'),
  BROW_SHAPE: makeColor('#90C890'),
  BROW_ADD_ON: makeColor('#CBE5CB'),
} as const satisfies Record<string, ServiceColor>;

/**
 * Lightweight shape so any caller can supply just the fields we
 * actually read. Keeps the helper decoupled from the full
 * `Appointment` type so it can be reused from places that synthesise
 * a partial appointment-ish object (tests, future Service preview UI,
 * etc.) without dragging the whole interface along.
 *
 * `booking_time` + `end_time` are optional but strongly recommended:
 * without them the matcher cannot disambiguate the bare "Classic" /
 * "Hybrid" / "Volume" fill-children (which exist three times in
 * Cal.com — once under each of 2-/3-/4-Week Fill — with identical
 * titles AND non-distinguishing slugs like `classic-jbb4f3`). The
 * only signal the booking row carries that tells them apart is the
 * appointment's actual duration: 120 min → 2 Week, 150 min → 3 Week,
 * 180 min → 4 Week. See the duration-fallback block in
 * `getServiceColor` for the canonical mapping.
 */
export interface ServiceColorInput {
  service_name?: string | null;
  service_slug?: string | null;
  /** ISO 8601 timestamp; used for duration-based disambiguation. */
  booking_time?: string | null;
  /** ISO 8601 timestamp; used for duration-based disambiguation. */
  end_time?: string | null;
}

/**
 * Compute the appointment's actual minute-length from its ISO
 * timestamps. Returns `null` for any missing / malformed / non-
 * positive duration so the caller can treat "unknown duration" as
 * "don't fall back to duration heuristics".
 */
function durationMinutes(
  bookingTime: string | null | undefined,
  endTime: string | null | undefined
): number | null {
  if (!bookingTime || !endTime) return null;
  const start = Date.parse(bookingTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const mins = Math.round((end - start) / 60000);
  return mins > 0 ? mins : null;
}

/**
 * Map an appointment to its category colour, or `null` when no rule
 * matches. The matcher runs in two passes:
 *
 *   Pass 1 — TITLE / SLUG, specificity-ordered.
 *     Concatenated lower-case haystack of `service_name` (cleaned of
 *     Cal.com's "between …" suffix) and `service_slug`. Most-specific
 *     probes go first so "Hybrid Full Set" hits FULL_SET before
 *     anything resembling a bare "Hybrid" fill could shortcut it.
 *
 *   Pass 2 — DURATION fallback for ambiguous fill-children only.
 *     The Cal.com event-types for "Classic" / "Hybrid" / "Volume"
 *     under 2-/3-/4-Week Fill all share titles AND have slugs like
 *     `classic-jbb4f3` with no week marker. The booking row's actual
 *     length (end_time − booking_time) is the only reliable signal:
 *       120 min  → 2 Week Fill (#FEC2D6)
 *       150 min  → 3 Week Fill (#F99DBC)
 *       180 min  → 4 Week Fill (#758D93)
 *     Full Sets are also 180 min but never reach this branch — they
 *     already won Pass 1 via the "full set" probe.
 */
export function getServiceColor(
  input: ServiceColorInput
): ServiceColor | null {
  // Strip the Cal.com "between …" suffix the same way the display
  // helper does, so the matcher operates on the raw service title
  // rather than the full event subject line.
  const title = (input.service_name || '')
    .split(/\s+between\s+/i)[0]
    .trim()
    .toLowerCase();
  const slug = (input.service_slug || '').toLowerCase();
  const haystack = `${title} ${slug}`;

  // The "X-week" probes accept both spaced ("4 week"), hyphenated
  // ("4-week"), and squashed ("4week") variants because we have no
  // guarantee whether the Cal.com slug uses dashes or spaces.
  const includesAny = (...needles: string[]) =>
    needles.some((n) => haystack.includes(n));

  // ── Pass 1: title / slug substring match (most → least specific) ──
  if (includesAny('full set', 'full-set', 'fullset')) {
    return SERVICE_COLORS.FULL_SET;
  }
  if (includesAny('first time', 'first-time', 'firsttime')) {
    return SERVICE_COLORS.FIRST_TIME_FILL;
  }
  if (includesAny('4 week', '4-week', '4week')) {
    return SERVICE_COLORS.FOUR_WEEK_FILL;
  }
  if (includesAny('3 week', '3-week', '3week')) {
    return SERVICE_COLORS.THREE_WEEK_FILL;
  }
  if (includesAny('2 week', '2-week', '2week')) {
    return SERVICE_COLORS.TWO_WEEK_FILL;
  }
  if (includesAny('korean')) {
    return SERVICE_COLORS.KOREAN_LIFT;
  }
  if (includesAny('lamination', 'lam tint', 'lam-tint')) {
    return SERVICE_COLORS.LAM_TINT_WAX;
  }
  if (includesAny('brow shape', 'brow-shape', 'brow wax', 'brow-wax')) {
    // Brow Shape's Cal slug is `brow-wax-…` historically (it was named
    // "Brow Wax" before being renamed to "Brow Shape" in the admin),
    // so we keep both keywords here to cover legacy slugs alongside
    // the current title.
    return SERVICE_COLORS.BROW_SHAPE;
  }
  if (includesAny('brow add', 'brow-add')) {
    return SERVICE_COLORS.BROW_ADD_ON;
  }

  // ── Pass 2: duration disambiguation for fill-children only ──
  // Restrict to the three exact titles ("classic" / "hybrid" /
  // "volume") so we don't accidentally colour-code an unrelated
  // future 120/150/180-minute service by length alone.
  const isBareFillChild =
    title === 'classic' || title === 'hybrid' || title === 'volume';
  if (isBareFillChild) {
    const mins = durationMinutes(input.booking_time, input.end_time);
    if (mins === 120) return SERVICE_COLORS.TWO_WEEK_FILL;
    if (mins === 150) return SERVICE_COLORS.THREE_WEEK_FILL;
    if (mins === 180) return SERVICE_COLORS.FOUR_WEEK_FILL;
  }
  return null;
}
