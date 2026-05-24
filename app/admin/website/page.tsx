import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import ImageUploader from './ImageUploader';

/**
 * Force dynamic for the same reason as /admin: this page reads Clerk
 * cookies and queries Postgres on every render. Letting Next try to
 * statically optimise it would fail at build time when the env vars
 * aren't available.
 */
export const dynamic = 'force-dynamic';

interface SiteImageRow {
  id: string;
  image_url: string;
  caption: string | null;
}

/**
 * Stored slot record we hand down to each <ImageUploader />. Both
 * fields can be null independently: a slot may have an image
 * uploaded but no custom caption (fall back to the hardcoded
 * `.p-tag` text), or a caption pre-populated but no image yet.
 */
interface SlotRecord {
  url: string | null;
  caption: string | null;
}

/**
 * Slot IDs that currently appear on the live site. Used purely as a
 * server-side filter on the SELECT — orphan rows (e.g. a leftover
 * `services_lashes` upload from a previous schema) get dropped from
 * the lookup map so they don't take memory or render hidden cards.
 *
 * The actual UI layout below addresses each slot by id directly (no
 * `.map()` over a single catalogue) because the layout itself encodes
 * design intent — Core Pages is a 2-up shape comparison and the
 * Portfolio Collage is a 2+3 puzzle. A generic loop can't express that.
 */
const KNOWN_SLOT_IDS = [
  'home_hero',
  'about_profile',
  'portfolio_1',
  'portfolio_2',
  'portfolio_3',
  'portfolio_4',
  'portfolio_5',
] as const;

/**
 * Subtle "hidden by navbar" indicator for the homepage hero preview.
 *
 * The live site's fixed navbar is 95% opaque navy and sits over the
 * top of the 100vh hero image — anything an editor places there is
 * effectively invisible on the live site. Without a hint here, the
 * editor sees the full image in the uploader and can pick a photo
 * whose key subject lands in that masked zone.
 *
 * Height ratio — 6%:
 *
 *   The live nav is roughly 60–80px tall (60px scrolled, 80px at
 *   rest) over a 100vh hero. On the typical desktop viewport heights
 *   we design for (≈900–1080px) that lands at 6–8%. We bias to the
 *   lower end here so the mask never claims more vertical territory
 *   than the actual navbar consumes — editors found 8% read as the
 *   admin over-stating the hidden zone vs. the public site.
 *
 * Why this colour (#1E3A8A) and not the brand `--navy` family:
 *
 *   The brand navy `#0D1B2A` and navy-light `#2A4460` are dark AND
 *   low-chroma blues. At <40% alpha, the warm photo tones (skin,
 *   hair, fabric) overwhelm what little chroma they carry and the
 *   band reads as plain grey. #1E3A8A (Tailwind blue-900) is in the
 *   same dark-blue family but carries roughly 2× the chroma. At 30%
 *   alpha it has enough hue dominance to override warm pixels
 *   underneath and read as unambiguously *blue* without darkening
 *   the image meaningfully. This is a deliberate departure from the
 *   brand token because the token's purpose here is editorial
 *   communication ("this is the navbar zone"), and that signal must
 *   survive low alpha.
 */
function HeroNavMask() {
  return (
    <div className="absolute inset-x-0 top-0 h-[6%] bg-[#1E3A8A]/30" />
  );
}

export default async function WebsiteEditorPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Same allowlist as the main dashboard. Middleware enforces "signed in"
  // for /admin/**, this gate enforces "signed in AND on the allowlist".
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  // Fetched separately from getAdminAccess (which intentionally only
  // returns access-control fields) because the header just needs a
  // friendly display name and not the full user object — pulled here
  // so we can pass it down to <AdminHeader />.
  const user = await currentUser();
  const displayName =
    user?.firstName || access.emails[0] || 'Admin';

  // ── DATA FETCH ────────────────────────────────────────────────────────
  // Single unfiltered SELECT — @vercel/postgres's `sql` tagged template
  // doesn't accept array params (e.g. `WHERE id = ANY(${ids})` fails type-
  // check), and a CMS image table will only ever hold a handful of rows.
  // Cheaper to filter client-side than to build a raw query string for
  // such a small table.
  let slotMap: Record<string, SlotRecord> = {};
  let dbError: string | null = null;
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url, caption FROM site_images
    `;
    const knownIds = new Set<string>(KNOWN_SLOT_IDS);
    slotMap = Object.fromEntries(
      rows
        .filter((r) => knownIds.has(r.id))
        .map((r) => [r.id, { url: r.image_url, caption: r.caption }])
    );
  } catch (err) {
    console.error('[admin/website] site_images query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  // Small conveniences to keep the JSX below readable.
  const urlFor = (id: string): string | null => slotMap[id]?.url ?? null;
  const captionFor = (id: string): string | null =>
    slotMap[id]?.caption ?? null;

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      {/*
        Header chrome (eyebrow + page title + sign-out cluster) is shared
        with /admin via <AdminHeader />, so the bar height + typographic
        register stay pixel-identical between section tabs — only the
        page body below should change when navigating.

        The page-level explainer ("Replace the images that appear across
        the public site …") used to live in this header. It was moved
        into the body where shifting between tabs is permitted, so the
        header itself can match /admin's compact `text-2xl + py-4` form.
      */}
      <AdminHeader title="Website Editor" displayName={displayName} />

      <AdminSectionTabs />

      {/* ── Body ──────────────────────────────────────────────────────
          Both sections (Core Pages + Portfolio) share the same reading
          column (`max-w-6xl px-6`) and the same heading register
          (`font-serif text-xl`) so the page reads as one coherent
          surface. Only the section *contents* differ — Core Pages is
          two stacked uploader cards, Portfolio is the collage grid
          wrapped in a single card — which gives the page the uniform
          feel the editor asked for without homogenising the actual
          editing affordances.                                              */}
      <main className="mx-auto max-w-6xl space-y-10 px-6 py-8">
        <p className="text-sm text-stone-500">
          Replace the images that appear across the public site. Changes
          go live the moment the upload completes.
        </p>

        {dbError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load existing images: {dbError}. You can still
            upload new ones — they will appear after the page reloads.
          </div>
        )}

        {/* ── SECTION 1 — Core Pages ─────────────────────────────────
            Hero + About: two visually distinct shapes (4:5 portrait vs
            3:4 portrait) shown side-by-side so an editor sees the
            actual shape they're filling. `items-start` is essential —
            the two cards have meaningfully different natural heights
            and we don't want CSS Grid's default `align-items: stretch`
            to rubber-band them to the same height.                          */}
        <section>
          <h2 className="mb-6 font-serif text-xl text-stone-900">
            Core Pages
          </h2>
          <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
            <ImageUploader
              imageId="home_hero"
              label="Homepage Hero Image"
              currentUrl={urlFor('home_hero')}
              aspectClass="aspect-[4/5]"
              chromeOverlay={<HeroNavMask />}
            />
            <ImageUploader
              imageId="about_profile"
              label="About Section Portrait"
              currentUrl={urlFor('about_profile')}
              aspectClass="aspect-[3/4]"
            />
          </div>
        </section>

        {/* ── SECTION 2 — Portfolio & Gallery Collage ───────────────
            Live-site geometry (12-col, 320px + 240px rows, 10px gap,
            p-item-1: 5/12, p-item-2: 7/12, p-item-3/4/5: 4/12 each on
            row 2) preserved verbatim. What changed from the previous
            full-bleed treatment:

              • The whole section now lives inside the same max-w-6xl
                column as Core Pages, so horizontal alignment is
                consistent between sections.
              • The grid is wrapped in a white card whose padding
                exactly equals the inter-tile gap (`p-[10px]`,
                `gap-[10px]`), so every tile sits at the same 10px
                inset from any neighbour — card edge or sibling.
                Reads as one uniform mosaic.
              • The 860px-and-below reflow (p-item-1 / p-item-2 each
                taking their own row) is preserved.                          */}
        <section>
          <h2 className="mb-6 font-serif text-xl text-stone-900">
            Portfolio &amp; Gallery Collage
          </h2>
          <div className="rounded-xl border border-stone-200 bg-white p-[10px] shadow-sm">
            <div
              className="
                grid gap-[10px]
                grid-cols-12 grid-rows-[280px_220px]
                max-[860px]:grid-rows-[260px_220px_180px]
              "
            >
              {/*
                Labels are the exact `.p-tag` strings hard-coded in
                public/index.html (lines 257, 262, 267, 272, 277).
                Using them here rather than admin-only slot names makes
                the editor a true 1:1 visual preview — hovering a tile
                reveals the same caption that will read on the live
                site. The slot identity is still unambiguous because
                the grid order matches the live site exactly.
              */}
              <ImageUploader
                variant="tile"
                imageId="portfolio_1"
                label="Classic Lashes"
                currentUrl={urlFor('portfolio_1')}
                initialCaption={captionFor('portfolio_1')}
                className="col-span-5 row-start-1 max-[860px]:col-span-12 max-[860px]:row-start-1"
              />
              <ImageUploader
                variant="tile"
                imageId="portfolio_2"
                label="Glow Facial"
                currentUrl={urlFor('portfolio_2')}
                initialCaption={captionFor('portfolio_2')}
                className="col-span-7 row-start-1 max-[860px]:col-span-12 max-[860px]:row-start-2"
              />
              <ImageUploader
                variant="tile"
                imageId="portfolio_3"
                label="Brow Lamination"
                currentUrl={urlFor('portfolio_3')}
                initialCaption={captionFor('portfolio_3')}
                className="col-span-4 row-start-2 max-[860px]:row-start-3"
              />
              <ImageUploader
                variant="tile"
                imageId="portfolio_4"
                label="Volume Set"
                currentUrl={urlFor('portfolio_4')}
                initialCaption={captionFor('portfolio_4')}
                className="col-span-4 row-start-2 max-[860px]:row-start-3"
              />
              <ImageUploader
                variant="tile"
                imageId="portfolio_5"
                label="Skin Treatment"
                currentUrl={urlFor('portfolio_5')}
                initialCaption={captionFor('portfolio_5')}
                className="col-span-4 row-start-2 max-[860px]:row-start-3"
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
