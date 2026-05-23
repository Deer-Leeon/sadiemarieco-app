/**
 * GET /
 *
 * Dynamic homepage handler. Reads the static marketing HTML from
 * `public/index.html`, does two CMS injections on it, and returns the
 * rendered page:
 *
 *   1. <img data-image-id="X" …> tags are rewritten to point at the
 *      most recently uploaded blob URL for slot X. Editor uploads
 *      from /admin/website land on the live site without a redeploy.
 *
 *   2. The `<!-- INJECT_SERVICES_HTML -->` token inside the services
 *      grid is replaced with a rendered service catalogue grouped by
 *      category. The structure matches the .services-cols / .service-
 *      item geometry the rest of the page (and js/main.js) expects.
 *
 * Why a route handler instead of an app/page.tsx Server Component:
 *   The marketing HTML is 500+ lines of static markup with a fully
 *   wired-up Cal.com booking drawer, FAQ accordion, fade-in scroll
 *   animations, and font preloading — all coupled to css/styles.css
 *   and js/main.js. Porting it to JSX would be a significant rewrite
 *   with real regression risk for the booking flow.
 *
 *   Instead we keep the HTML untouched and slip the CMS data in on
 *   the way out via targeted substitutions. The page renders
 *   identically except for the slots we explicitly hot-swap.
 *
 * Caching:
 *   - `dynamic = 'force-dynamic'` opts out of Next.js's data cache so
 *     every request re-runs both DB queries.
 *   - `Cache-Control: no-store` opts out of browser AND Vercel CDN
 *     caches so admin uploads + service edits appear immediately on
 *     the public site.
 *
 * Performance:
 *   - The HTML file contents are cached at module scope after the first
 *     request — a single ~20KB read per cold serverless instance, then
 *     in-memory for the lifetime of that instance.
 *   - Two parallel DB queries (site_images + site_services) and a few
 *     string substitutions per request. Sub-ms substitution work.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from '@vercel/postgres';

// Node.js runtime required for `node:fs` — the Edge runtime doesn't
// expose the filesystem. Default runtime for route handlers is already
// Node, but pinning it explicitly future-proofs against accidental
// upgrades that flip the default.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cal.com account handle used to construct `data-cal-link` attributes
 * (`{username}/{slug}`). Hardcoded for now to match the existing
 * booking-drawer wiring; promote to a CAL_USERNAME env var once the
 * studio has its own production handle separate from the developer's.
 *
 * Source of truth: the namespace component of the URLs the existing
 * static HTML referenced before this route became CMS-driven, e.g.
 * `data-cal-link="leon-buchmiller-xepszb/classic-full-set"`.
 */
const CAL_USERNAME = 'leon-buchmiller-xepszb';

/**
 * Token placed in public/index.html inside `<div class="services-cols">`.
 * Replaced verbatim with the rendered services catalogue on every
 * request. Defined once here so the HTML template and the renderer
 * stay in lockstep — a typo on either side would simply skip the
 * injection (the regex match would fail) rather than corrupt the page.
 */
const SERVICES_TOKEN = '<!-- INJECT_SERVICES_HTML -->';

interface SiteImageRow {
  id: string;
  image_url: string;
}

interface SiteServiceRow {
  id: number;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from node-postgres
  duration_mins: number;
  slug: string | null;
}

// Module-scope cache for the static HTML. Safe because the file only
// changes on deploy (which spins up a fresh serverless instance with an
// empty cache). In dev, Next's HMR re-evaluates this module on file
// change so the cache resets automatically.
let cachedHtml: string | null = null;

async function loadIndexHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  const filePath = path.join(process.cwd(), 'public', 'index.html');
  cachedHtml = await fs.readFile(filePath, 'utf-8');
  return cachedHtml;
}

/**
 * Replace `src` attributes on `<img>` tags that carry a recognised
 * `data-image-id`. The regex matches any `<img …>` tag, extracts the
 * data-image-id (if present), and rewrites src only when we have a
 * CMS URL for that id. Tags without `data-image-id` — or whose id
 * isn't in the DB — are passed through unchanged, which is exactly
 * the "keep the hardcoded fallback" behaviour the spec asked for.
 *
 * Robustness notes:
 *   - Matches double-quoted attributes only. The existing HTML uses
 *     double quotes consistently; if you ever switch to single quotes
 *     in index.html, update the regex.
 *   - Doesn't match self-closing `<img … />` because we don't use that
 *     syntax in our HTML (and HTML5 doesn't require it).
 *   - `[^>]*` is greedy-up-to-the-next-`>`, which can fail if an
 *     attribute value itself contains a literal `>` (e.g. `alt="x > y"`).
 *     Acceptable here; we control the HTML and don't do that.
 */
function injectImageUrls(html: string, imageMap: Record<string, string>): string {
  if (Object.keys(imageMap).length === 0) return html;
  return html.replace(/<img\s+[^>]*>/g, (tag) => {
    const idMatch = tag.match(/data-image-id="([^"]+)"/);
    if (!idMatch) return tag;
    const url = imageMap[idMatch[1]];
    if (!url) return tag;
    return tag.replace(/src="[^"]*"/, `src="${url}"`);
  });
}

export async function GET(): Promise<Response> {
  let html: string;
  try {
    html = await loadIndexHtml();
  } catch (err) {
    // If the HTML file is genuinely missing in production something is
    // catastrophically wrong with the deploy — surface a 500 so the
    // alert hits us instead of serving a confusing blank page.
    console.error('[/] failed to read public/index.html:', err);
    return new Response('Marketing page unavailable.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // ── DATA FETCH ────────────────────────────────────────────────────────
  // Both queries run in parallel — they target different tables and
  // share no dependencies, so there's no reason to serialise them.
  // Either failing is non-fatal: missing images fall back to the
  // hardcoded URLs in index.html, and missing services leave the
  // injection token unreplaced (which produces an empty grid that
  // still validates as HTML).
  const [imageMap, servicesHtml] = await Promise.all([
    fetchImageMap(),
    fetchServicesHtml(),
  ]);

  let rendered = injectImageUrls(html, imageMap);
  rendered = rendered.replace(SERVICES_TOKEN, servicesHtml);

  return new Response(rendered, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Three-layer opt-out (browser, intermediate proxies, Vercel CDN)
      // so an upload or a service edit appears on the next page load
      // without waiting on a stale cache.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

async function fetchImageMap(): Promise<Record<string, string>> {
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url FROM site_images
    `;
    return Object.fromEntries(rows.map((r) => [r.id, r.image_url]));
  } catch (err) {
    console.error('[/] site_images query failed:', err);
    return {};
  }
}

/**
 * Queries `site_services` and returns the rendered HTML that should
 * replace `SERVICES_TOKEN`. Returns an empty string on DB failure so
 * the page still renders (with an empty grid) rather than 500ing the
 * whole homepage on a transient Postgres hiccup.
 *
 * ORDER BY category DESC, id ASC:
 *   • category DESC lexically: "Lash Services" > "Brow Services", so
 *     lashes appear in the left column and brows on the right, which
 *     matches the legacy hardcoded order the studio is used to.
 *   • id ASC within each category preserves insertion order, so the
 *     editor's "I added these in this sequence" mental model is the
 *     order customers see them in too.
 */
async function fetchServicesHtml(): Promise<string> {
  try {
    const { rows } = await sql<SiteServiceRow>`
      SELECT
        id,
        category,
        title,
        description,
        price,
        duration_mins,
        slug
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY category DESC, id ASC
    `;
    return renderServicesHtml(rows);
  } catch (err) {
    console.error('[/] site_services query failed:', err);
    return '';
  }
}

/**
 * Render the catalogue as HTML matching the exact .services-cols /
 * .service-item / .service-header / .service-meta structure expected
 * by public/css/styles.css and the booking-drawer wiring in
 * public/js/main.js.
 *
 * Layout rules:
 *   • One <div class="reveal[ reveal-delay-N]"> per category, in the
 *     order the rows arrived (category DESC). The reveal-delay-N
 *     class wires the scroll-in animation; index 0 has no delay,
 *     index 1 gets reveal-delay-1, etc. — matches the legacy markup.
 *   • A <div class="col-rule"></div> divider between adjacent
 *     category columns. CSS turns this into the vertical hairline.
 *   • Inside each column, the .category-head label followed by one
 *     .service-item per row in the input order.
 *
 * Safety:
 *   All dynamic text passes through escapeHtml() so a title like
 *   `Sadie's <Best>` can't break out of an attribute or smuggle a
 *   script tag onto the page. data-cal-link is omitted entirely when
 *   slug is null so the booking drawer no-ops on click rather than
 *   navigating to a broken URL.
 */
function renderServicesHtml(rows: readonly SiteServiceRow[]): string {
  if (rows.length === 0) return '';

  const groups = groupByCategory(rows);

  const columns = groups.map(([category, services], index) => {
    const delayClass = index === 0 ? '' : ` reveal-delay-${index}`;
    const items = services.map(renderServiceItem).join('\n');
    return `
    <div class="reveal${delayClass}">
      <div class="category-head">${escapeHtml(category)}</div>
${items}
    </div>`;
  });

  return columns.join('\n\n    <div class="col-rule"></div>\n');
}

function renderServiceItem(service: SiteServiceRow): string {
  const calLinkAttr =
    service.slug !== null
      ? ` data-cal-link="${escapeAttr(`${CAL_USERNAME}/${service.slug}`)}"`
      : '';
  return `      <div class="service-item"${calLinkAttr}>
        <div class="service-header">
          <div>
            <span class="service-name">${escapeHtml(service.title)}</span>
            <span class="service-detail">${escapeHtml(service.description)}</span>
          </div>
          <div class="service-meta">
            <span class="service-price">${escapeHtml(formatPrice(service.price))}</span>
            <span class="service-duration">${escapeHtml(formatDuration(service.duration_mins))}</span>
          </div>
        </div>
      </div>`;
}

function groupByCategory(
  rows: readonly SiteServiceRow[]
): Array<[string, SiteServiceRow[]]> {
  // Map preserves insertion order — since rows arrive sorted by
  // category DESC, the resulting Map keys are already in the order
  // we want to render columns.
  const map = new Map<string, SiteServiceRow[]>();
  for (const row of rows) {
    const list = map.get(row.category);
    if (list) list.push(row);
    else map.set(row.category, [row]);
  }
  return Array.from(map.entries());
}

/**
 * Format a NUMERIC price string as the live site renders prices:
 * `$165` for whole-dollar amounts, `$12.50` when there are cents.
 * Trims a trailing `.00` from `Number.toFixed(2)` so the typography
 * stays clean on the menu (the original hardcoded HTML was all whole
 * dollars; we keep that look unless the studio explicitly enters a
 * fractional amount).
 */
function formatPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return `$${price}`;
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  return `${minutes} min`;
}

/**
 * Escape a string for safe interpolation into HTML element text or
 * attribute values. Covers the five characters that can break out of
 * common contexts: &, <, >, ", '.
 *
 * We deliberately don't use a third-party sanitiser here — the input
 * is a closed enum of fields under our control (no markdown, no HTML)
 * and the rendering happens server-side. Five replacements cover the
 * full set of escapes the WHATWG HTML spec needs for text content
 * and double-quoted attribute values.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Same as escapeHtml but kept as a separate symbol so any future
 * attribute-only quirks (e.g. URI encoding, mixed quoting policy)
 * can be addressed without touching the text-content path. Today
 * the implementations are identical.
 */
function escapeAttr(value: string): string {
  return escapeHtml(value);
}
