/**
 * GET /
 *
 * Dynamic homepage handler. Reads the static marketing HTML from
 * `public/index.html`, queries the `site_images` table for CMS-managed
 * image URLs, and rewrites the `<img>` tags whose `data-image-id`
 * attribute matches a known slot before returning the page.
 *
 * Why a route handler instead of an app/page.tsx Server Component:
 *   The marketing HTML is 500+ lines of static markup with a fully
 *   wired-up Cal.com booking drawer, FAQ accordion, fade-in scroll
 *   animations, and font preloading — all coupled to css/styles.css
 *   and js/main.js. Porting it to JSX would be a significant rewrite
 *   with real regression risk for the booking flow.
 *
 *   Instead we keep the HTML untouched and slip the CMS image URLs in
 *   on the way out via a single string substitution. The page renders
 *   identically except that <img data-image-id="X"> tags now point at
 *   the most recently uploaded blob URL for slot X.
 *
 * Caching:
 *   - `dynamic = 'force-dynamic'` opts out of Next.js's data cache so
 *     every request re-runs the DB query.
 *   - `Cache-Control: no-store` opts out of browser AND Vercel CDN
 *     caches so admin uploads appear immediately on the public site
 *     (the requirement that drove Option B over a static port).
 *
 * Performance:
 *   - The HTML file contents are cached at module scope after the first
 *     request — a single ~25KB read per cold serverless instance, then
 *     in-memory for the lifetime of that instance.
 *   - Only the DB query + regex substitution run per request. The
 *     substitution is ~6 regex matches on a ~500-line string. Sub-ms.
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

interface SiteImageRow {
  id: string;
  image_url: string;
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

  let imageMap: Record<string, string> = {};
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url FROM site_images
    `;
    imageMap = Object.fromEntries(rows.map((r) => [r.id, r.image_url]));
  } catch (err) {
    // DB outage is non-fatal — we serve the HTML with the hardcoded
    // fallback image URLs. Logged so we can spot a pattern of failures.
    console.error('[/] site_images query failed:', err);
  }

  const rendered = injectImageUrls(html, imageMap);

  return new Response(rendered, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Three-layer opt-out (browser, intermediate proxies, Vercel CDN)
      // so an image uploaded in /admin/website appears on the next page
      // load without waiting on a stale cache.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
