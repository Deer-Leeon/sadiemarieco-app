/**
 * Service → colour mapping for appointment chrome across the admin
 * dashboard (list view, 3-day / week time grid, month grid, single-
 * day modal, client-profile history). The full appointment block is
 * painted in the service's colour with white labels on top — the
 * studio's chosen treatment, applied uniformly so every appointment
 * pill reads with the same hierarchy regardless of background hex.
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
  /** Primary text colour to use on top of `accent`. Pinned to white
   *  so every appointment in the list / 3-day / week / month views
   *  uses the same foreground regardless of the service hex. The
   *  studio prefers a single, consistent text colour across the
   *  catalogue and chooses pill backgrounds that read against white. */
  text: string;
  /** De-emphasised secondary text colour (timestamp lines, service
   *  subtitles). Held to ~78 % white opacity so the title/subtitle
   *  hierarchy survives even on the lightest pastel pills. */
  textMuted: string;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Build a {@link ServiceColor} from a single source-of-truth hex.
 *
 * Text is intentionally pinned to white (with a 78%-opacity white
 * for the muted/subtitle tone) for every accent. We previously ran
 * a YIQ luminance check that flipped pastel backgrounds to dark
 * stone text, but the studio asked for a single, consistent text
 * colour across every pill in the calendar views — easier to scan,
 * and matches their styling preference of "white labels on coloured
 * blocks". If a future service hex needs dark text again, lift the
 * threshold back in and keep this helper as the single decision
 * point.
 */
function makeColor(hex: string): ServiceColor {
  return {
    accent: hex,
    text: '#ffffff',
    textMuted: 'rgba(255, 255, 255, 0.78)',
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
