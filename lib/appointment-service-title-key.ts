/**
 * Token bag used to match Cal.com appointment titles to `site_services.title`.
 *
 * Cal and the CMS drift independently — commas, plus signs, and word order
 * ("Lamination, Tint, + Wax" vs "Lamination, Wax, + Tint") used to miss the
 * JOIN and paint the booking as colourless even though a hex was set.
 *
 * Keep this in lock-step with `matchCatalogueService` in
 * `lib/match-catalogue-service.ts`.
 */

const STOP_WORDS = new Set(['a', 'and', 'plus', 'the', 'with']);

export function appointmentServiceTitleKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const primary = raw.split(/\s+between\s+/i)[0] ?? '';
  const tokens = primary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  tokens.sort();
  return tokens.join(' ');
}

export const BARE_FILL_TITLE_KEYS = new Set(['classic', 'hybrid', 'volume']);
