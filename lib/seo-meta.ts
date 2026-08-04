/**
 * Shared public SEO constants and HTML head helpers for the marketing site.
 */
import {
  STUDIO_BRAND_NAME,
  STUDIO_LEGAL_NAME,
  STUDIO_OG_IMAGE_URL,
  STUDIO_SITE_URL,
} from '@/lib/studio-nap';

export const SEO_DEFAULT_TITLE =
  'Sadie Marie | Lash Extensions & Brows in Lehi, UT';

export const SEO_DEFAULT_DESCRIPTION =
  'Sadie Marie in Lehi, Utah — luxury lash extensions, brow artistry, and signature beauty services for clients across Utah County.';

/** Favicon + touch icon link tags for static HTML <head>s. */
export function faviconLinkTags(): string {
  return [
    `<link rel="icon" href="/favicon.ico" sizes="any">`,
    `<link rel="icon" type="image/png" sizes="16x16" href="/assets/brand/favicon-16.png">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png">`,
    `<link rel="icon" type="image/png" sizes="48x48" href="/assets/brand/favicon-48.png">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
  ].join('\n  ');
}

export function buildMetaHead(opts: {
  title: string;
  description: string;
  canonicalPath: string;
  ogType?: string;
  noIndex?: boolean;
}): string {
  const url = new URL(opts.canonicalPath, STUDIO_SITE_URL).toString();
  const ogType = opts.ogType ?? 'website';
  const robots = opts.noIndex
    ? `<meta name="robots" content="noindex, nofollow">`
    : `<meta name="robots" content="index, follow, max-image-preview:large">`;

  return [
    `<title>${escapeHtml(opts.title)}</title>`,
    `<meta name="description" content="${escapeAttr(opts.description)}">`,
    robots,
    `<link rel="canonical" href="${escapeAttr(url)}">`,
    faviconLinkTags(),
    `<meta property="og:type" content="${escapeAttr(ogType)}">`,
    `<meta property="og:site_name" content="${escapeAttr(STUDIO_BRAND_NAME)}">`,
    `<meta property="og:title" content="${escapeAttr(opts.title)}">`,
    `<meta property="og:description" content="${escapeAttr(opts.description)}">`,
    `<meta property="og:url" content="${escapeAttr(url)}">`,
    `<meta property="og:image" content="${escapeAttr(STUDIO_OG_IMAGE_URL)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeAttr(opts.title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(opts.description)}">`,
    `<meta name="twitter:image" content="${escapeAttr(STUDIO_OG_IMAGE_URL)}">`,
    `<meta name="author" content="${escapeAttr(STUDIO_LEGAL_NAME)}">`,
  ].join('\n  ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
