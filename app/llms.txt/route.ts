/**
 * GET /llms.txt
 *
 * Factual markdown brief for assistants that fetch the site while answering.
 * Facts come from the same sources as the public site. This file is not a
 * ranking signal, and it does not claim the studio is the best or the only
 * option in Utah County.
 *
 * Requests ending in `.txt` skip `proxy.ts`, so a blocked crawler can still
 * read this brief. It does not expose booking or payment APIs.
 */

import { NextResponse } from 'next/server';

import { loadBookableServices, type BookableService } from '@/lib/book-public';
import { HOMEPAGE_FAQS } from '@/lib/seo-json-ld';
import {
  STUDIO_ADDRESS_ONE_LINE,
  STUDIO_AREA_SERVED,
  STUDIO_BRAND_NAME,
  STUDIO_EMAIL,
  STUDIO_GOOGLE_MAPS_URL,
  STUDIO_GOOGLE_REVIEW_URL,
  STUDIO_HOST_VENUE,
  STUDIO_INSTAGRAM_URL,
  STUDIO_PHONE_DISPLAY,
  STUDIO_SITE_URL,
} from '@/lib/studio-nap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MENU_URL = `${STUDIO_SITE_URL}/#services`;
const HOURS_URL = `${STUDIO_SITE_URL}/#contact`;
const BOOK_URL = `${STUDIO_SITE_URL}/book`;

const PAGES = [
  { path: '/', label: 'Home' },
  { path: '/lash-extensions-lehi', label: 'Lash extensions in Lehi' },
  { path: '/brow-services-lehi', label: 'Brow services in Lehi' },
  { path: '/beauty-studio-lehi', label: 'Beauty studio in Lehi' },
  { path: '/areas-we-serve', label: 'Areas we serve' },
  { path: '/book', label: 'Book an appointment' },
  { path: '/privacy', label: 'Privacy' },
  { path: '/terms', label: 'Terms' },
] as const;

function cityName(area: string): string {
  return area.replace(/, UT$/, '');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function groupByCategory(
  services: readonly BookableService[]
): Array<[string, BookableService[]]> {
  const groups = new Map<string, BookableService[]>();
  for (const service of services) {
    const category = service.category || 'Services';
    const list = groups.get(category);
    if (list) list.push(service);
    else groups.set(category, [service]);
  }
  return [...groups.entries()];
}

function renderServices(services: readonly BookableService[]): string {
  if (services.length === 0) {
    return `## Services and Pricing\nThe current menu is at ${MENU_URL}\n`;
  }

  const sections = groupByCategory(services).map(([category, rows]) => {
    const lines = rows.map(
      (service) =>
        `- ${oneLine(service.title)}: ${service.priceLabel}, ${service.durationLabel}`
    );
    return `### ${oneLine(category)}\n${lines.join('\n')}`;
  });

  return [
    '## Services and Pricing',
    `Prices below are the current public menu. Book at ${BOOK_URL}`,
    '',
    sections.join('\n\n'),
  ].join('\n');
}

function renderBrief(services: readonly BookableService[] | null): string {
  const cities = STUDIO_AREA_SERVED.map(cityName);
  const cityList = cities.join(', ');

  const servicesSection = services
    ? renderServices(services)
    : `## Services and Pricing\nThe current menu is at ${MENU_URL}\n`;

  const faqs = HOMEPAGE_FAQS.map(
    (item) => `Q: ${oneLine(item.question)}\nA: ${oneLine(item.answer)}`
  ).join('\n\n');

  const pages = [
    ...PAGES.map(
      (page) =>
        `- ${page.label}: ${page.path === '/' ? `${STUDIO_SITE_URL}/` : `${STUDIO_SITE_URL}${page.path}`}`
    ),
    ...(services ?? []).map(
      (service) =>
        `- ${oneLine(service.title)}: ${STUDIO_SITE_URL}/services/${encodeURIComponent(service.slug)}`
    ),
  ].join('\n');

  return [
    `# ${STUDIO_BRAND_NAME}`,
    '',
    `${STUDIO_BRAND_NAME} is a Lehi, Utah studio for lash extensions and brow artistry at ${STUDIO_HOST_VENUE}. Clients visit from ${cityList}.`,
    '',
    '## About',
    `McKenna, a licensed cosmetologist and graduate of Taylor Andrews Academy, owns ${STUDIO_BRAND_NAME}. The studio is ${STUDIO_BRAND_NAME} at ${STUDIO_HOST_VENUE} in Lehi, Utah, and offers personalized lash extensions and brow artistry.`,
    '',
    servicesSection,
    '',
    '## Location',
    `- ${STUDIO_BRAND_NAME} at ${STUDIO_HOST_VENUE}`,
    `- ${STUDIO_ADDRESS_ONE_LINE}`,
    `- Map: ${STUDIO_GOOGLE_MAPS_URL}`,
    '',
    '## Contact',
    `- Phone: ${STUDIO_PHONE_DISPLAY}`,
    `- Email: ${STUDIO_EMAIL}`,
    `- Website: ${STUDIO_SITE_URL}`,
    `- Instagram: ${STUDIO_INSTAGRAM_URL}`,
    `- Google review: ${STUDIO_GOOGLE_REVIEW_URL}`,
    `- Hours: published on ${HOURS_URL} and updated from the studio calendar`,
    '',
    '## Service Area',
    cityList,
    '',
    '## Booking',
    BOOK_URL,
    '',
    '## Pages',
    pages,
    '',
    '## Frequently Asked Questions',
    faqs,
    '',
  ].join('\n');
}

export async function GET(): Promise<NextResponse> {
  let services: BookableService[] | null = null;
  try {
    services = await loadBookableServices();
  } catch (err) {
    console.warn('[llms.txt] menu unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return new NextResponse(renderBrief(services), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
