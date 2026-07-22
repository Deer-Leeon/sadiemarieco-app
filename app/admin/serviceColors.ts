/**
 * Service → colour mapping for appointment chrome across the admin
 * dashboard (list view, 3-day / week time grid, month grid, single-
 * day modal, client-profile history). The full appointment block is
 * painted in the service's colour with auto-contrasted text (white
 * on dark backgrounds, near-black on pastels) chosen by YIQ
 * luminance so every hex stays legible.
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
  /** Primary text colour to use on top of `accent`. Auto-chosen per
   *  background luminance so saturated blues / magentas / greens
   *  keep white text while pastel pinks, mints, and yellows flip to
   *  near-black for contrast. */
  text: string;
  /** De-emphasised secondary text colour (timestamp lines, service
   *  subtitles) — same luminance bucket as `text` but at reduced
   *  opacity so the hierarchy survives the high-contrast colour shift. */
  textMuted: string;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Build a {@link ServiceColor} from a single source-of-truth hex.
 * Picks the foreground text colour based on the background's YIQ
 * luminance — the 150 threshold flips deep magentas / forest-greens
 * onto white text while leaving pastels (light pink, mint, yellow)
 * on near-black so labels stay readable.
 */
function makeColor(hex: string): ServiceColor {
  const { r, g, b } = hexToRgb(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  const isDark = yiq < 150;
  return {
    accent: hex,
    text: isDark ? '#ffffff' : '#000000',
    textMuted: isDark ? 'rgba(255, 255, 255, 0.78)' : 'rgba(0, 0, 0, 0.65)',
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
