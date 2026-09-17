/**
 * Service → colour mapping for appointment chrome across the admin
 * dashboard (list view, 3-day / week time grid, month grid, single-
 * day modal, client-profile history). The full appointment block is
 * painted in the service's colour; label colour flips black/white
 * from background luminance so pastels stay readable.
 *
 * Resolution strategy:
 *   The hex comes from `site_services.color` exclusively — the
 *   editor picks it in /admin/services and it travels onto each
 *   appointment row via the LEFT JOIN LATERAL (Cal event-type id first,
 *   then title), then a token-bag fallback (`lib/match-catalogue-service.ts`) so punctuation and
 *   word order ("Lamination, Tint, + Wax" vs "Lamination, Wax, + Tint")
 *   still resolve to the same catalogue hex. Bare fill children
 *   ("Classic" / "Hybrid" / "Volume") are matched by title key AND
 *   appointment duration so 2-/3-/4-week fills each keep their own hex
 *   (see `appointmentServiceLabel` in helpers.ts).
 *   There is intentionally NO fallback heuristic any more — the
 *   studio asked for full manual control over which service gets
 *   which colour, so an unset service renders the original neutral
 *   stone chrome until the editor assigns one.
 *
 * Returning `null` is the documented fall-through. Callers render
 * the unchanged neutral chrome (and the existing no-show / cancelled
 * grey treatments take precedence over colour-coding regardless).
 */

export interface ServiceColor {
  /** Solid hex painted as the appointment block's full background. */
  accent: string;
  /** Primary text colour on top of `accent` (black or white from YIQ). */
  text: string;
  /** De-emphasised secondary text colour (timestamp lines, service
   *  subtitles) — same light/dark bucket as `text` at reduced opacity. */
  textMuted: string;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * YIQ brightness threshold. Values at or above this get black labels;
 * darker fills keep white. 128 is the classic midpoint and matches
 * the contrast approach referenced by the services API / migrations.
 */
const YIQ_BLACK_TEXT_THRESHOLD = 128;

/**
 * Prefer black text when the background is light enough that white
 * labels fail WCAG-ish contrast (sky blue, medium pink, pastels, etc.).
 */
export function usesBlackText(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  // NTSC / YIQ luma — same formula historically used in this codebase.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= YIQ_BLACK_TEXT_THRESHOLD;
}

/**
 * Build a {@link ServiceColor} from a single source-of-truth hex.
 * Foreground flips from background luminance so any editor-picked
 * pastel stays legible without a hard-coded exception list.
 */
function makeColor(hex: string): ServiceColor {
  const black = usesBlackText(hex);
  return {
    accent: hex,
    text: black ? '#000000' : '#ffffff',
    textMuted: black ? 'rgba(0, 0, 0, 0.72)' : 'rgba(255, 255, 255, 0.88)',
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
 * Lightweight shape so any caller can supply just the fields we
 * actually read. Keeps the helper decoupled from the full
 * `Appointment` type so it can be reused from places that synthesise
 * a partial appointment-ish object (admin service-card preview, etc.)
 * without dragging the whole interface along.
 */
export interface ServiceColorInput {
  /**
   * Editor-assigned hex from `site_services.color` (joined onto the
   * appointment row). The ONLY signal that produces a colour — there
   * is no longer a name / duration heuristic that fabricates one
   * from thin air, so when this is null/blank the function returns
   * null and the caller renders neutral chrome. Expected canonical
   * form is `#RRGGBB` (enforced by the DB CHECK constraint), but we
   * accept any 6-digit hex case-insensitively as a defensive read.
   */
  service_color?: string | null;
}

/**
 * Resolve an appointment's calendar colour from its editor-assigned
 * `service_color`. Returns `null` for any service whose `color`
 * column is NULL — that's the explicit "no colour assigned" signal
 * the studio chose by removing the auto-matcher, and the calling
 * view should fall back to its neutral stone chrome in that case.
 *
 * We rebuild the full `ServiceColor` shape (accent + text +
 * textMuted) via `makeColor` so every consumer gets the same
 * three-token contract whether the hex came from a freshly-saved
 * CMS row or a historical backfill.
 */
export function getServiceColor(
  input: ServiceColorInput
): ServiceColor | null {
  const hex = input.service_color?.trim();
  if (hex && HEX_COLOR_RE.test(hex)) {
    return makeColor(hex.toUpperCase());
  }
  return null;
}

export interface VisitBlockPaint {
  backgroundColor?: string;
  backgroundImage?: string;
}

function catalogueWeight(mins: number | null | undefined): number {
  if (typeof mins === 'number' && Number.isFinite(mins) && mins > 0) {
    return mins;
  }
  return 60;
}

/**
 * One continuous pill: parent colour fading into extra colours in
 * add order. Weights follow catalogue durations, scaled to the chair.
 */
export function visitBlockBackground(appointment: {
  service_color?: string | null;
  catalogue_duration_mins?: number | null;
  extras?: Array<{
    service_color?: string | null;
    catalogue_duration_mins?: number | null;
  }> | null;
}): VisitBlockPaint | null {
  const extras = appointment.extras ?? [];
  const parent = getServiceColor(appointment);
  if (!parent) return null;
  if (extras.length === 0) {
    return { backgroundColor: parent.accent };
  }

  const segments: { hex: string; weight: number }[] = [
    { hex: parent.accent, weight: catalogueWeight(appointment.catalogue_duration_mins) },
  ];
  for (const extra of extras) {
    const color = getServiceColor(extra);
    segments.push({
      hex: color?.accent ?? parent.accent,
      weight: catalogueWeight(extra.catalogue_duration_mins),
    });
  }

  const unique = new Set(segments.map((s) => s.hex.toUpperCase()));
  if (unique.size === 1) {
    return { backgroundColor: segments[0]!.hex };
  }

  const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
  const blendPct = Math.min(8, Math.max(3, (6 / Math.max(totalWeight, 1)) * 100));
  const stops: string[] = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const start = (cursor / totalWeight) * 100;
    const end = ((cursor + seg.weight) / totalWeight) * 100;
    const next = segments[i + 1];
    if (!next) {
      stops.push(`${seg.hex} ${start}%`, `${seg.hex} 100%`);
    } else {
      const seam = end;
      const half = Math.min(blendPct, (end - start) / 2, ((next.weight / totalWeight) * 100) / 2);
      stops.push(
        `${seg.hex} ${start}%`,
        `${seg.hex} ${Math.max(start, seam - half)}%`,
        `${next.hex} ${Math.min(100, seam + half)}%`
      );
    }
    cursor += seg.weight;
  }

  return {
    backgroundImage: `linear-gradient(to bottom, ${stops.join(', ')})`,
  };
}
