/**
 * Quiet public pages for each bookable service, and the live service
 * lists injected into the existing lash, brow, and studio landings.
 * Copy stays factual: the menu's own description, price, and length.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  loadBookableServiceBySlug,
  loadBookableServices,
  type BookableService,
} from '@/lib/book-public';
import { buildMetaHead } from '@/lib/seo-meta';
import { jsonLdScriptTag } from '@/lib/seo-json-ld';
import { serviceFamily, type ServiceFamily } from '@/lib/service-family';
import {
  STUDIO_ADDRESS_LINE1,
  STUDIO_ADDRESS_ONE_LINE,
  STUDIO_BRAND_NAME,
  STUDIO_CITY,
  STUDIO_COUNTRY,
  STUDIO_EMAIL,
  STUDIO_HOST_VENUE,
  STUDIO_PHONE_DISPLAY,
  STUDIO_PHONE_E164,
  STUDIO_POSTAL,
  STUDIO_REGION,
  STUDIO_SITE_URL,
} from '@/lib/studio-nap';

export const SERVICE_LINKS_TOKEN = '<!-- INJECT_SERVICE_LINKS -->';

export type { ServiceFamily } from '@/lib/service-family';
export { serviceFamily } from '@/lib/service-family';

const LANDING_FILE: Record<ServiceFamily, string> = {
  lash: 'lash-extensions-lehi.html',
  brow: 'brow-services-lehi.html',
  other: 'beauty-studio-lehi.html',
};

const FAMILY_HEADING: Record<ServiceFamily, string> = {
  lash: 'Lash services',
  brow: 'Brow services',
  other: 'Other services',
};

const FAMILY_PARENT: Record<
  ServiceFamily,
  { path: string; label: string }
> = {
  lash: { path: '/lash-extensions-lehi', label: 'All lash services' },
  brow: { path: '/brow-services-lehi', label: 'All brow services' },
  other: { path: '/beauty-studio-lehi', label: 'The studio' },
};

export function servicePagePath(slug: string): string {
  return `/services/${encodeURIComponent(slug)}`;
}

export function serviceBookPath(slug: string): string {
  return `/book?service=${encodeURIComponent(slug)}`;
}

export function renderServiceLinkList(
  services: readonly BookableService[],
  family: ServiceFamily
): string {
  if (services.length === 0) return '';
  const items = services
    .map((service) => {
      const href = servicePagePath(service.slug);
      return `<li><a href="${escapeAttr(href)}">${escapeHtml(service.title)}</a> — ${escapeHtml(service.priceLabel)}, ${escapeHtml(service.durationLabel)}</li>`;
    })
    .join('\n      ');
  return `<h2>${escapeHtml(FAMILY_HEADING[family])}</h2>
    <ul>
      ${items}
    </ul>`;
}

export function renderServicePage(service: BookableService): string {
  const family = serviceFamily(service.category);
  const parent = FAMILY_PARENT[family];
  const path = servicePagePath(service.slug);
  const bookPath = serviceBookPath(service.slug);
  const title = `${service.title} in Lehi, UT | ${STUDIO_BRAND_NAME}`;
  const description = metaDescription(service);
  const whatItIs = service.description?.trim()
    ? `<h2>What it is</h2>
    ${paragraphs(service.description.trim())}`
    : '';

  const jsonLd = jsonLdScriptTag({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.title,
    description,
    url: `${STUDIO_SITE_URL}${path}`,
    areaServed: `${STUDIO_CITY}, ${STUDIO_REGION}`,
    provider: {
      '@type': 'BeautySalon',
      name: STUDIO_BRAND_NAME,
      url: STUDIO_SITE_URL,
      telephone: STUDIO_PHONE_E164,
      email: STUDIO_EMAIL,
      address: {
        '@type': 'PostalAddress',
        streetAddress: STUDIO_ADDRESS_LINE1,
        addressLocality: STUDIO_CITY,
        addressRegion: STUDIO_REGION,
        postalCode: STUDIO_POSTAL,
        addressCountry: STUDIO_COUNTRY,
      },
      containedInPlace: {
        '@type': 'Place',
        name: STUDIO_HOST_VENUE,
      },
    },
    offers: {
      '@type': 'Offer',
      price: service.price,
      priceCurrency: 'USD',
      url: `${STUDIO_SITE_URL}${bookPath}`,
    },
  });

  const body = `<nav id="navbar" class="portal-nav">
  <a href="/" class="nav-logo">${escapeHtml(STUDIO_BRAND_NAME)}</a>
  <a href="${escapeAttr(bookPath)}" class="portal-nav-back">Book</a>
</nav>

<main class="legal-main seo-landing-main">
  <header class="legal-masthead">
    <span class="section-label">${escapeHtml(service.category)} · Lehi</span>
    <h1 class="legal-title">${escapeHtml(service.title)} in <em>Lehi, Utah</em></h1>
    <div class="section-divider"></div>
    <p class="legal-updated">${escapeHtml(STUDIO_BRAND_NAME)} at ${escapeHtml(STUDIO_HOST_VENUE)}</p>
  </header>

  <div class="legal-prose seo-landing-prose">
    ${whatItIs}
    <h2>What to expect</h2>
    <p>
      ${escapeHtml(service.title)} takes ${escapeHtml(service.durationLabel)} and is ${escapeHtml(service.priceLabel)}.
      ${escapeHtml(STUDIO_BRAND_NAME)} at ${escapeHtml(STUDIO_HOST_VENUE)}, ${escapeHtml(STUDIO_ADDRESS_ONE_LINE)}.
    </p>
    <p>
      <a class="btn-navy seo-landing-cta" href="${escapeAttr(bookPath)}">Book ${escapeHtml(service.title)}</a>
    </p>
    <p class="seo-landing-related">
      <a href="${escapeAttr(parent.path)}">${escapeHtml(parent.label)}</a>
    </p>
  </div>
</main>

${landingFooter()}`;

  return renderSeoDocument({ title, description, canonicalPath: path, jsonLd, body });
}

export function renderServiceNotFound(): string {
  const body = `<nav id="navbar" class="portal-nav">
  <a href="/" class="nav-logo">${escapeHtml(STUDIO_BRAND_NAME)}</a>
  <a href="/book" class="portal-nav-back">Book</a>
</nav>
<main class="legal-main seo-landing-main">
  <header class="legal-masthead">
    <h1 class="legal-title">Service not found</h1>
  </header>
  <div class="legal-prose seo-landing-prose">
    <p>That service is not on the current menu.</p>
    <p class="seo-landing-related">
      <a href="/lash-extensions-lehi">Lash services</a> ·
      <a href="/brow-services-lehi">Brow services</a> ·
      <a href="/beauty-studio-lehi">The studio</a>
    </p>
  </div>
</main>
${landingFooter()}`;
  return renderSeoDocument({
    title: `Service not found | ${STUDIO_BRAND_NAME}`,
    description: 'That service is not on the current Sadie Marie menu.',
    canonicalPath: '/services',
    jsonLd: '',
    body,
    noIndex: true,
  });
}

export async function renderLandingHtml(family: ServiceFamily): Promise<string> {
  const filePath = path.join(
    process.cwd(),
    'content/seo',
    LANDING_FILE[family]
  );
  const html = await readFile(filePath, 'utf-8');
  let services: BookableService[] = [];
  try {
    const menu = await loadBookableServices();
    services = menu.filter((service) => serviceFamily(service.category) === family);
  } catch (err) {
    console.warn('[seo-landing] menu unavailable', {
      family,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return html.replace(SERVICE_LINKS_TOKEN, renderServiceLinkList(services, family));
}

export async function loadServicePage(slug: string): Promise<BookableService | null> {
  return loadBookableServiceBySlug(slug);
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: HTML_HEADERS });
}

function metaDescription(service: BookableService): string {
  const lead = service.description?.trim();
  const facts = `${service.title} at ${STUDIO_BRAND_NAME} in Lehi, Utah. ${service.priceLabel}, ${service.durationLabel}.`;
  const text = lead ? `${lead} ${facts}` : facts;
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n    ');
}

function landingFooter(): string {
  return `<footer>
  <span class="footer-logo">${escapeHtml(STUDIO_BRAND_NAME)}</span>
  <p class="footer-copy">© 2026 ${escapeHtml(STUDIO_BRAND_NAME)} · Lehi, Utah</p>
  <ul class="footer-links">
    <li><a href="/">Home</a></li>
    <li><a href="/lash-extensions-lehi">Lashes</a></li>
    <li><a href="/brow-services-lehi">Brows</a></li>
    <li><a href="/beauty-studio-lehi">Studio</a></li>
    <li><a href="/areas-we-serve">Location</a></li>
    <li><a href="/privacy">Privacy</a></li>
  </ul>
</footer>
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>
<script>
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
</script>
<script defer src="/_vercel/speed-insights/script.js"></script>`;
}

function renderSeoDocument(opts: {
  title: string;
  description: string;
  canonicalPath: string;
  jsonLd: string;
  body: string;
  noIndex?: boolean;
}): string {
  const head = buildMetaHead({
    title: opts.title,
    description: opts.description,
    canonicalPath: opts.canonicalPath,
    noIndex: opts.noIndex,
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0D1B2A">
  <meta name="color-scheme" content="light">
  ${head}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,600;0,6..96,700;1,6..96,400;1,6..96,600&family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=DM+Sans:wght@200;300;400&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/styles.css">
  ${opts.jsonLd}
</head>
<body class="legal-body seo-landing-body">
<script src="/js/open-in-browser.js"></script>
${opts.body}
</body>
</html>`;
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
