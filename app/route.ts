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

import { reconcileWithCal } from './admin/services/sync';

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
 * Updated May 2026 from the developer's personal handle
 * (`leon-buchmiller-xepszb`) to the studio's production account
 * (`mckenna-sadiemarie`) after the Cal.com account migration. The
 * slug component on each service row is unchanged; only the
 * namespace before the `/` swaps.
 */
const CAL_USERNAME = 'mckenna-sadiemarie';

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
  caption: string | null;
}

/**
 * Render-time view of a site_images row. URL is required (a row
 * without one shouldn't exist — the upload route writes both in
 * the same upsert). Caption semantics on the public site:
 *   • NULL  → keep hardcoded `.p-tag` text from `public/index.html`
 *   • ''    → hide the tag and gradient overlay entirely
 *   • text  → replace with the CMS value
 */
interface SiteImage {
  url: string;
  caption: string | null;
}

interface SiteServiceRow {
  id: number;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from node-postgres
  /**
   * Null for group headers — they don't carry a duration of their
   * own. The renderer omits the .service-duration span entirely for
   * these rows.
   */
  duration_mins: number | null;
  /** Null for group headers (no Cal event-type behind them). */
  slug: string | null;
  /** True for accordion-header rows; false for bookable services. */
  is_group: boolean;
  /**
   * Optional self-reference: when set, this row renders inside the
   * accordion shelf of its parent group. The renderer bubbles orphan
   * children (parent_id pointing at a row that no longer exists or
   * isn't a group) up to the top level so they remain visible.
   */
  parent_id: number | null;
}

// Module-scope cache for the static HTML. Safe in production because
// the file only changes on deploy (which spins up a fresh serverless
// instance with an empty cache).
//
// In development we deliberately skip the cache: files under `public/`
// are static assets, not part of the React module graph, so Next's HMR
// does NOT re-evaluate this route module when index.html changes.
// Without a re-read on every dev request, edits to the marketing HTML
// would only appear after a full dev-server restart — surprising and
// easy to mistake for a code bug. The re-read is a single ~25KB disk
// hit, negligible at dev volumes.
let cachedHtml: string | null = null;

async function loadIndexHtml(): Promise<string> {
  if (cachedHtml && process.env.NODE_ENV === 'production') return cachedHtml;
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
/**
 * Preconnect + preload the homepage hero so the browser starts fetching
 * the LCP image as soon as `<head>` is parsed — in parallel with fonts
 * and CSS — instead of waiting for the `<body>` `<img>` tag.
 */
function injectLcpHints(
  html: string,
  imageMap: Record<string, SiteImage>
): string {
  const heroUrl = imageMap.home_hero?.url;
  if (!heroUrl) return html;

  let origin: string;
  try {
    origin = new URL(heroUrl).origin;
  } catch {
    return html;
  }

  const hints = [
    `<link rel="preconnect" href="${origin}" crossorigin>`,
    `<link rel="preload" as="image" href="${heroUrl}" fetchpriority="high">`,
  ].join('\n  ');

  return html.replace('</head>', `  ${hints}\n</head>`);
}

function injectImageUrls(
  html: string,
  imageMap: Record<string, SiteImage>
): string {
  if (Object.keys(imageMap).length === 0) return html;
  return html.replace(/<img\s+[^>]*>/g, (tag) => {
    const idMatch = tag.match(/data-image-id="([^"]+)"/);
    if (!idMatch) return tag;
    const entry = imageMap[idMatch[1]];
    if (!entry?.url) return tag;
    return tag.replace(/src="[^"]*"/, `src="${entry.url}"`);
  });
}

/**
 * Replace or remove `<span ... data-caption-id="X" ...>` tags based on
 * the caption stored in `imageMap` for slot X:
 *   • No DB row          → leave hardcoded fallback text in place
 *   • caption NULL       → same (editor never customised the caption)
 *   • caption ''         → remove the span (no text, no gradient)
 *   • non-empty caption  → inject escaped custom text
 *
 * Robustness notes mirror `injectImageUrls`:
 *   - Double-quoted attributes only.
 *   - `[^<]*` for the inner text — we control the source HTML and
 *     never put nested tags inside `.p-tag`.
 *   - `[^>]*?` (non-greedy) inside the open tag so multi-span
 *     lines don't get swallowed across siblings.
 */
function injectCaptions(
  html: string,
  imageMap: Record<string, SiteImage>
): string {
  if (Object.keys(imageMap).length === 0) return html;
  return html.replace(
    /<span\s+([^>]*?)data-caption-id="([^"]+)"([^>]*)>([^<]*)<\/span>/g,
    (match, before: string, id: string, after: string, _text: string) => {
      const entry = imageMap[id];
      if (!entry) return match;
      if (entry.caption === null) return match;
      const caption = entry.caption.trim();
      if (caption.length === 0) return '';
      return `<span ${before}data-caption-id="${id}"${after}>${escapeHtml(caption)}</span>`;
    }
  );
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

  // ── RECONCILE WITH CAL (TTL-throttled) ────────────────────────────────
  // Sync orphans before reading site_services so a service deleted
  // directly from the Cal.com dashboard disappears from the public
  // menu within the cache window. We DON'T pass `force: true` here —
  // this is a high-traffic path and a per-visitor Cal round-trip is
  // wasteful. The default 60-second TTL in sync.ts means we hit Cal
  // at most once a minute regardless of visitor volume.
  //
  // The admin path (`/admin/services` Server Component) force-runs
  // the reconciler on every load, so editors see orphans disappear
  // immediately. The public site converges on the same DB state
  // within the next TTL window — by the time a customer browses, the
  // editor has usually already triggered the reconcile.
  //
  // The reconciler swallows its own errors, so a Cal outage can't
  // break the homepage render.
  // ── DATA FETCH ────────────────────────────────────────────────────────
  // Cal reconcile + both DB queries run in parallel. Reconcile used to
  // block the whole response serially (~200–500ms TTFB); images and
  // services don't depend on it finishing first.
  const [, imageMap, servicesHtml] = await Promise.all([
    reconcileWithCal(),
    fetchImageMap(),
    fetchServicesHtml(),
  ]);

  let rendered = injectLcpHints(html, imageMap);
  rendered = injectImageUrls(rendered, imageMap);
  rendered = injectCaptions(rendered, imageMap);
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

async function fetchImageMap(): Promise<Record<string, SiteImage>> {
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url, caption FROM site_images
    `;
    return Object.fromEntries(
      rows.map((r) => [r.id, { url: r.image_url, caption: r.caption }])
    );
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
 * ORDER BY display_order ASC, id ASC:
 *   • Global sequence set in /admin/services ("Save Order").
 *   • groupByCategory preserves row order within each category bucket.
 *   • Category columns use PUBLIC_CATEGORY_COLUMN_RANK (Lash left,
 *     Brow right) — must stay aligned with /admin/services.
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
        slug,
        is_group,
        parent_id
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC
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
 *   • Inside each column, the .category-head label followed by either
 *     a bare .service-item per bookable row, or a .service-group
 *     wrapping a group header + indented .service-group-children
 *     accordion shelf for each group.
 *
 * Hierarchy handling:
 *   • Group rows (is_group=true) get a non-bookable .service-item--
 *     group header with a "From " prefix on the price and no
 *     duration. They carry data-service-group="<id>" so the inlined
 *     accordion script can find them.
 *   • Child rows (parent_id pointing to an active group in the same
 *     category) render normally as .service-item inside their
 *     parent's .service-group-children container. The container
 *     carries the matching data-service-group-children="<id>".
 *   • Orphan children — parent_id pointing at a missing or non-group
 *     row — bubble up to the top level. The customer never sees a
 *     service vanish because of an inconsistent admin state; the
 *     editor sees the orphan in /admin/services to reassign or
 *     delete.
 *
 * Safety:
 *   All dynamic text passes through escapeHtml() so a title like
 *   `Sadie's <Best>` can't break out of an attribute or smuggle a
 *   script tag onto the page. data-cal-link is omitted entirely when
 *   slug is null so the booking drawer no-ops on click rather than
 *   navigating to a broken URL. Group rows never get data-cal-link
 *   regardless of slug — they're folders, not events.
 */
/**
 * Categories that the homepage renders as "coming soon" placeholders
 * instead of a dynamic service list. Rows in these categories are
 * filtered out of the dynamic render below so they can't accidentally
 * grow a third column on the two-up grid; they're surfaced as a
 * hardcoded sibling block underneath their host column. Admins can
 * still create rows in these categories via /admin/services to
 * pre-stage the launch catalogue — the rows just don't appear on
 * the public menu yet.
 */
const COMING_SOON_CATEGORIES = new Set(['Teeth Whitening']);

/**
 * Static "Coming soon." block injected at the bottom of the host
 * column for a placeholder category. Uses the same `.category-head`
 * vocabulary as the dynamic headers so the typography lines up
 * pixel-for-pixel; the body uses a `.coming-soon-note` class defined
 * in `public/css/styles.css` that inherits the muted italic serif
 * register of `.service-detail`.
 *
 * Visual rhythm: `.category-head--coming-soon` carries the extra
 * top margin so the brow services list and the new placeholder block
 * feel like two deliberate sections rather than a continuous list.
 */
function renderComingSoonBlock(category: string): string {
  return `
      <div class="coming-soon-wrapper">
        <div class="category-head">${escapeHtml(category)}</div>
        <p class="coming-soon-note">Coming soon.</p>
      </div>`;
}

/**
 * Decide which dynamic column should host each coming-soon placeholder.
 * Today: Teeth Whitening rides under Brow Services (the right column
 * of the two-up grid). If a coming-soon category gets reassigned to a
 * different column, update this map — the rest of the render pipeline
 * resolves the destination from this single source of truth.
 *
 * Fallback strategy: if the host category isn't in the current
 * render (e.g. the studio has zero brow services configured yet),
 * the block is appended to the LAST rendered column instead. That
 * keeps the placeholder visible during early menu seeding without
 * crashing the layout.
 */
const COMING_SOON_HOST_CATEGORY: Record<string, string> = {
  'Teeth Whitening': 'Brow Services',
};

/** Homepage column order — keep in sync with ServiceManager.tsx */
const PUBLIC_CATEGORY_COLUMN_RANK: Record<string, number> = {
  'Lash Services': 0,
  'Brow Services': 1,
  'Teeth Whitening': 2,
};

function renderServicesHtml(rows: readonly SiteServiceRow[]): string {
  if (rows.length === 0) {
    // Even with an empty service catalogue we still want the
    // placeholder columns to render so the homepage doesn't show a
    // blank pricing section. We emit a minimal scaffold: a (still
    // empty) two-column structure with the coming-soon block in the
    // right column. Editors will replace this scaffolding as soon as
    // they add their first service in /admin/services.
    const placeholder = Array.from(COMING_SOON_CATEGORIES)
      .map(renderComingSoonBlock)
      .join('\n');
    return `
    <div class="reveal"></div>

    <div class="col-rule"></div>
    <div class="reveal reveal-delay-1">
${placeholder}
    </div>${ACCORDION_SCRIPT}`;
  }

  // Strip coming-soon categories from the dynamic group set: they're
  // injected by-hand as a sibling block under their host column
  // below. Without this filter, a single Teeth Whitening row in the
  // DB would spawn a third grid column and break the two-up layout.
  const groups = groupByCategory(rows).filter(
    ([category]) => !COMING_SOON_CATEGORIES.has(category)
  );

  // Build a host-category → list-of-coming-soon-blocks map so a
  // column can absorb multiple placeholders if we ever add more.
  // Order within a host column is insertion order from
  // COMING_SOON_HOST_CATEGORY (today just the one).
  const extrasByHost = new Map<string, string[]>();
  for (const [comingSoon, host] of Object.entries(COMING_SOON_HOST_CATEGORY)) {
    if (!COMING_SOON_CATEGORIES.has(comingSoon)) continue;
    const list = extrasByHost.get(host) ?? [];
    list.push(renderComingSoonBlock(comingSoon));
    extrasByHost.set(host, list);
  }

  // Track which host categories we've actually rendered so we can
  // append any orphan placeholders (host missing from this build) to
  // the last column as a fallback.
  const renderedHosts = new Set<string>();

  const columns = groups.map(([category, services], index) => {
    const delayClass = index === 0 ? '' : ` reveal-delay-${index}`;
    const items = renderCategoryItems(services);
    const extras = extrasByHost.get(category);
    let extrasHtml = '';
    if (extras && extras.length > 0) {
      renderedHosts.add(category);
      extrasHtml = '\n' + extras.join('\n');
    }
    return `
    <div class="reveal${delayClass}">
      <div class="category-head">${escapeHtml(category)}</div>
${items}${extrasHtml}
    </div>`;
  });

  // Fallback: any coming-soon placeholder whose host wasn't in the
  // dynamic render gets appended to the last column. Keeps the
  // placeholder visible during early menu seeding (e.g. before the
  // studio adds its first brow service).
  for (const [host, extras] of extrasByHost.entries()) {
    if (renderedHosts.has(host)) continue;
    if (columns.length === 0) continue;
    const lastIndex = columns.length - 1;
    const trimmed = columns[lastIndex].replace(/\s*<\/div>\s*$/, '');
    columns[lastIndex] = `${trimmed}\n${extras.join('\n')}
    </div>`;
  }

  // Accordion toggle script appended once at the end of the injected
  // markup. Placed inside the services container (rather than before
  // </body>) so the only edit point on the public site is this single
  // <!-- INJECT_SERVICES_HTML --> token. A script element is parsed
  // and run as soon as the parser reaches it, by which point every
  // [data-service-group] element above already exists in the DOM,
  // so no DOMContentLoaded gate is needed.
  return (
    columns.join('\n\n    <div class="col-rule"></div>\n') + ACCORDION_SCRIPT
  );
}

function renderCategoryItems(services: readonly SiteServiceRow[]): string {
  // Discover which ids in this column are actually group headers.
  // Used twice below: once to build the children-by-parent map (only
  // honour parent_id pointers that resolve to a known group in this
  // column), and once to filter the top-level row list.
  const groupIds = new Set(
    services.filter((s) => s.is_group).map((s) => s.id)
  );

  const childrenByParent = new Map<number, SiteServiceRow[]>();
  for (const s of services) {
    if (s.parent_id !== null && groupIds.has(s.parent_id)) {
      const list = childrenByParent.get(s.parent_id);
      if (list) list.push(s);
      else childrenByParent.set(s.parent_id, [s]);
    }
  }

  // Top-level rows = groups + standalones + orphan children. The
  // orphan inclusion is the third condition: a non-group row whose
  // parent_id is set but doesn't resolve to a live group in this
  // column. We bubble it up so the customer always sees the service.
  const topLevel = services.filter(
    (s) =>
      s.is_group ||
      s.parent_id === null ||
      !groupIds.has(s.parent_id)
  );

  return topLevel
    .map((row) => {
      if (row.is_group) {
        return renderGroupHeader(row, childrenByParent.get(row.id) ?? []);
      }
      return renderServiceItem(row);
    })
    .join('\n');
}

function renderServiceItem(service: SiteServiceRow): string {
  const durationHtml =
    service.duration_mins !== null
      ? `\n              <span class="service-duration">${escapeHtml(
          formatDuration(service.duration_mins)
        )}</span>`
      : '';

  const priceMeta = `<div class="service-meta">
              <span class="service-price">${escapeHtml(formatPrice(service.price))}</span>${durationHtml}
            </div>`;

  // Slugless rows can't actually be booked (no Cal event-type to
  // route to) — render them as a passive <div> with no action zone
  // so the customer isn't promised an interaction the page can't
  // honour. In practice this branch only fires for legacy rows that
  // predate the slug column. Group headers take a different code
  // path (renderGroupHeader) below.
  if (service.slug === null) {
    return `      <div class="service-item">
        <div class="service-header">
          <div>
            <span class="service-name">${escapeHtml(service.title)}</span>
            <span class="service-detail">${escapeHtml(service.description)}</span>
          </div>
          ${priceMeta}
        </div>
      </div>`;
  }

  // Bookable variant.
  //
  //   • Wrapper is <a> with the canonical Cal.com URL as href so a
  //     no-JS visitor still lands on a bookable page when they click
  //     the row. The in-page drawer in public/js/main.js intercepts
  //     the click with preventDefault for everyone else.
  //   • data-cal-link is the username/slug pair the drawer uses to
  //     spin up the matching pre-rendered iframe.
  //   • .service-action is the right-side cue zone: it holds the
  //     price stack followed immediately by a static chevron that
  //     signals "this row opens something". The chevron does not
  //     animate on hover — only the row's background tint changes —
  //     so the cue stays calm and editorial rather than reading as a
  //     button. No "Book Now" label: the chevron alone is the cue.
  //   • The chevron is the typographic `›` glyph (U+203A) rendered in
  //     var(--serif) — Bodoni Moda. Using a glyph instead of an SVG
  //     means it inherits the page's display-serif character (high
  //     contrast, refined terminals) and scales with the surrounding
  //     prices automatically.
  const calUrl = `https://cal.com/${CAL_USERNAME}/${service.slug}`;
  return `      <a class="service-item" href="${escapeAttr(calUrl)}" data-cal-link="${escapeAttr(
    `${CAL_USERNAME}/${service.slug}`
  )}">
        <div class="service-header">
          <div>
            <span class="service-name">${escapeHtml(service.title)}</span>
            <span class="service-detail">${escapeHtml(service.description)}</span>
          </div>
          <div class="service-action">
            ${priceMeta}
            <span class="service-cue-arrow" aria-hidden="true">&rsaquo;</span>
          </div>
        </div>
      </a>`;
}

/**
 * Render a group header row + its indented children shelf. The
 * children container starts in the `.is-collapsed` state so the page
 * loads tidy; the inline accordion script toggles it on click.
 *
 * Empty groups (no active children) still render their header so the
 * editor sees the category structure they configured. Customers see
 * a non-collapsible header with no shelf beneath — visually identical
 * to a normal bookable row except for the "From " price prefix.
 */
function renderGroupHeader(
  parent: SiteServiceRow,
  children: readonly SiteServiceRow[]
): string {
  const headerRow = `      <div class="service-item service-item--group" data-service-group="${parent.id}">
        <div class="service-header">
          <div>
            <span class="service-name">${escapeHtml(parent.title)}</span>
            <span class="service-detail">${escapeHtml(parent.description)}</span>
          </div>
          <div class="service-meta">
            <span class="service-price"><span class="service-price-prefix">From </span>${escapeHtml(formatPrice(parent.price))}</span>
          </div>
        </div>
        <span class="service-group-toggle" aria-hidden="true"></span>
      </div>`;

  if (children.length === 0) {
    return `      <div class="service-group">
${headerRow}
      </div>`;
  }

  const childItems = children.map(renderServiceItem).join('\n');
  return `      <div class="service-group">
${headerRow}
        <div class="service-group-children is-collapsed" data-service-group-children="${parent.id}">
${childItems}
        </div>
      </div>`;
}

/**
 * Inline accordion controller. Attaches a click handler to every
 * group header (`[data-service-group]`) that toggles the matching
 * children shelf (`[data-service-group-children="<id>"]`) in and out
 * of the `.is-collapsed` state.
 *
 * Design choices:
 *   • Plain IIFE rather than DOMContentLoaded — by the time this
 *     script element parses, every group element above it is already
 *     in the DOM (HTML parses top-to-bottom; scripts run inline as
 *     they're reached). Avoids a brief flash where clicks before
 *     DCL would no-op.
 *   • Click swallowing: if the click target sits inside a child
 *     element with data-cal-link, the booking drawer in main.js owns
 *     that click. We bail out so toggling the parent shelf doesn't
 *     accidentally happen on top of an in-flight booking action. In
 *     practice children sit INSIDE the children container (not the
 *     header), so this guard only matters if a future refactor nests
 *     a bookable element inside the header itself.
 *   • Toggling adds `is-expanded` to the parent in addition to
 *     `is-collapsed` on the children — gives the CSS a hook to
 *     rotate a chevron or recolour the header without scanning for
 *     the sibling state.
 */
const ACCORDION_SCRIPT = `

    <script>
      (function () {
        var parents = document.querySelectorAll('[data-service-group]');
        for (var i = 0; i < parents.length; i++) {
          (function (parent) {
            parent.addEventListener('click', function (e) {
              if (e.target.closest('[data-cal-link]')) return;
              var id = parent.getAttribute('data-service-group');
              var children = document.querySelector(
                '[data-service-group-children="' + id + '"]'
              );
              if (!children) return;
              children.classList.toggle('is-collapsed');
              parent.classList.toggle('is-expanded');
            });
          })(parents[i]);
        }
      })();
    </script>`;

function groupByCategory(
  rows: readonly SiteServiceRow[]
): Array<[string, SiteServiceRow[]]> {
  const map = new Map<string, SiteServiceRow[]>();
  for (const row of rows) {
    const list = map.get(row.category);
    if (list) list.push(row);
    else map.set(row.category, [row]);
  }
  return Array.from(map.entries()).sort(([a], [b]) => {
    const rankA = PUBLIC_CATEGORY_COLUMN_RANK[a] ?? 50;
    const rankB = PUBLIC_CATEGORY_COLUMN_RANK[b] ?? 50;
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b);
  });
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
