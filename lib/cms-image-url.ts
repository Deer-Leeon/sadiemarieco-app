/**
 * Build `/_next/image` URLs for CMS photos. Re-encodes blob sources as
 * WebP/AVIF (non-progressive) so the hero LCP asset downloads faster and
 * never paints blurry progressive-JPEG scan passes.
 */

/** Max width passed to the optimizer — covers 2× retina on a ~960px column. */
export const HERO_CMS_MAX_WIDTH = 1920;

export function nextImageUrl(
  src: string,
  width: number,
  quality = 85
): string {
  const params = new URLSearchParams({
    url: src,
    w: String(width),
    q: String(quality),
  });
  return `/_next/image?${params.toString()}`;
}

/** Public URL for the homepage hero slot (CMS blob or bundled fallback). */
export function heroDeliveryUrl(sourceUrl: string): string {
  if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
    return nextImageUrl(sourceUrl, HERO_CMS_MAX_WIDTH);
  }
  const path = sourceUrl.startsWith('/') ? sourceUrl : `/${sourceUrl}`;
  return nextImageUrl(path, HERO_CMS_MAX_WIDTH);
}
