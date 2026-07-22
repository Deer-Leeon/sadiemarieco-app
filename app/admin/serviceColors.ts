/**
 * Service → colour mapping for appointment chrome across the admin
 * dashboard (list view, 3-day / week time grid, month grid, single-
 * day modal, client-profile history). The full appointment block is
 * painted in the service's colour with white labels by default;
 * only three pastel accents (lightest pink, lightest green, yellow)
 * flip to black text for contrast.
 *
 * Resolution strategy:
 *   The hex comes from `site_services.color` exclusively — the
 *   editor picks it in /admin/services and it travels onto each
 *   appointment row via the LEFT JOIN LATERAL in
 *   `app/admin/page.tsx` and `/api/admin/clients/[id]/appointments`.
 *   Bare fill children ("Classic" / "Hybrid" / "Volume") are matched
 *   by title AND appointment duration so 2-/3-/4-week fills each keep
 *   their own hex (see `appointmentServiceLabel` in helpers.ts).
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
  /** Primary text colour on top of `accent`. White for nearly every
   *  service; black only for the three pastel accents listed in
   *  {@link BLACK_TEXT_ACCENTS}. */
  text: string;
  /** De-emphasised secondary text colour (timestamp lines, service
   *  subtitles) — same light/dark bucket as `text` at reduced opacity. */
  textMuted: string;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * The only backgrounds that render black labels. Everything else —
 * including medium pinks, sky blue, sage green, and hot magenta —
 * keeps white text.
 *
 * Values match the studio's current pastel picks (screenshot-sampled
 * / palette). A small RGB distance tolerance absorbs colour-picker
 * rounding without sweeping in neighbouring mid-tones like `#FEC2D6`.
 */
const BLACK_TEXT_ACCENTS: readonly { r: number; g: number; b: number }[] = [
  { r: 0xfe, g: 0xdc, b: 0xea }, // lightest pink
  { r: 0xcb, g: 0xe5, b: 0xcb }, // lightest green (Brow Add-On `#CBE5CB`)
  { r: 0xfe, g: 0xf4, b: 0xb4 }, // yellow
];

/** Max city-block RGB distance to count as one of the three pastels. */
const BLACK_TEXT_RGB_SLOP = 18;

function usesBlackText(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return BLACK_TEXT_ACCENTS.some(
    (target) =>
      Math.abs(r - target.r) +
        Math.abs(g - target.g) +
        Math.abs(b - target.b) <=
      BLACK_TEXT_RGB_SLOP
  );
}

/**
 * Build a {@link ServiceColor} from a single source-of-truth hex.
 * Default foreground is white; only the three pastel accents in
 * {@link BLACK_TEXT_ACCENTS} flip to black.
 */
function makeColor(hex: string): ServiceColor {
  const black = usesBlackText(hex);
  return {
    accent: hex,
    text: black ? '#000000' : '#ffffff',
    textMuted: black ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.78)',
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
  if (input.service_color && HEX_COLOR_RE.test(input.service_color)) {
    return makeColor(input.service_color.toUpperCase());
  }
  return null;
}
