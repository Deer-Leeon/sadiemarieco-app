import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sql } from '@vercel/postgres';
import { ArrowLeft } from 'lucide-react';

import { getAdminAccess } from '../auth';
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
 * Live-site chrome overlay for the homepage hero slot. Rendered inside
 * the editor's hero preview so the editor sees a true 1:1 view of what
 * shows up on the live site.
 *
 * The hero image lives behind two stacked overlays on the public page:
 *
 *   1. The translucent navbar (`nav`, `position: fixed`,
 *      `background: rgba(13,27,42,0.95)`, ~80px tall on a 100vh hero
 *      ≈ 8% of the image height). See public/css/styles.css lines
 *      31–39.
 *
 *   2. A 35%-tall bottom-up navy gradient applied via
 *      `.hero-img-col::after` — `linear-gradient(to top,
 *      rgba(13,27,42,0.55) 0%, transparent 100%)`. See
 *      public/css/styles.css lines 100–106.
 *
 * Without this overlay the editor sees the entire untouched image and
 * can pick a photo whose key subject lands inside one of these masked
 * zones — which then disappears on the live site. With it, the editor
 * picks knowing exactly which pixels will read.
 */
function HeroLiveChrome() {
  return (
    <>
      {/*
        Nav band. The LIVE nav uses `rgba(13,27,42,0.95) + backdrop-blur(14px)`
        so the image is almost completely hidden behind it. In the editor
        that reads as a solid bar and the editor can't tell what subject
        they're putting under the nav.
        We deliberately render it as ~50% navy WITHOUT the blur so the
        underlying image is dimmed but still recognisable — i.e. the
        editor knows "this strip of my photo will sit behind the nav"
        and can see exactly which pixels those are. Less accurate than
        the live render, more useful as an editorial preview.
      */}
      <div className="absolute inset-x-0 top-0 h-[8%] border-b border-white/10 bg-[#0D1B2A]/50" />
      <div className="absolute inset-x-0 bottom-0 h-[35%] bg-linear-to-t from-[#0D1B2A]/55 to-transparent" />
    </>
  );
}

export default async function WebsiteEditorPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Same allowlist as the main dashboard. Middleware enforces "signed in"
  // for /admin/**, this gate enforces "signed in AND on the allowlist".
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  // ── DATA FETCH ────────────────────────────────────────────────────────
  // Single unfiltered SELECT — @vercel/postgres's `sql` tagged template
  // doesn't accept array params (e.g. `WHERE id = ANY(${ids})` fails type-
  // check), and a CMS image table will only ever hold a handful of rows.
  // Cheaper to filter client-side than to build a raw query string for
  // such a small table.
  let imageMap: Record<string, string> = {};
  let dbError: string | null = null;
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url FROM site_images
    `;
    const knownIds = new Set<string>(KNOWN_SLOT_IDS);
    imageMap = Object.fromEntries(
      rows.filter((r) => knownIds.has(r.id)).map((r) => [r.id, r.image_url])
    );
  } catch (err) {
    console.error('[admin/website] site_images query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  // Small convenience to keep the JSX below readable.
  const urlFor = (id: string): string | null => imageMap[id] ?? null;

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      {/* ── Page header ───────────────────────────────────────────────── */}
      <header className="border-b border-stone-200 bg-[#FAF9F6]/95 px-6 py-6 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500 transition-colors hover:text-stone-900"
            >
              <ArrowLeft className="h-3 w-3" />
              Sadie Marie · Admin
            </Link>
            <h1 className="mt-1 font-serif text-3xl leading-tight text-stone-900">
              Website Editor
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              Replace the images that appear across the public site. Changes
              go live the moment the upload completes.
            </p>
          </div>
        </div>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {dbError && (
          <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load existing images: {dbError}. You can still upload
            new ones — they will appear after the page reloads.
          </div>
        )}

        {/* ── SECTION 1 — Core Pages ──────────────────────────────────
            Hero + About: two visually distinct shapes (4:5 portrait vs
            3:4 portrait) shown side-by-side so an editor sees the actual
            shape they're filling. `items-start` is essential here — the
            two cards have meaningfully different natural heights and we
            don't want CSS Grid's default `align-items: stretch` to
            rubber-band them to the same height.                          */}
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
              chromeOverlay={<HeroLiveChrome />}
            />
            <ImageUploader
              imageId="about_profile"
              label="About Section Portrait"
              currentUrl={urlFor('about_profile')}
              aspectClass="aspect-[3/4]"
            />
          </div>
        </section>

        {/* ── SECTION 2 — Portfolio & Gallery Collage ─────────────────
            1:1 clone of the live `.portfolio-collage` from
            public/css/styles.css (lines 646–686):
              - 12-column grid
              - Two fixed rows: 320px tall (top) and 240px tall (bottom)
              - 10px gap, navy `#0D1B2A` backdrop (live `--navy`)
              - p-item-1: cols 1-5 (5/12 wide)
              - p-item-2: cols 6-12 (7/12 wide) — asymmetric on purpose
              - p-item-3/4/5: 4 cols each on row 2

            Mobile fallback (< md): collapses to a single column with
            each tile taking the full row at a fixed height, mirroring
            the live site's 860px-breakpoint behaviour.

            Each tile is a `variant="tile"` ImageUploader: edge-to-edge
            image, no card chrome, click to replace, hover reveals the
            slot label + pencil icon. This is what the live site looks
            like.                                                          */}
        <section>
          <h2 className="mb-6 mt-16 font-serif text-xl text-stone-900">
            Portfolio &amp; Gallery Collage
          </h2>
          <div
            className="
              grid gap-[10px] rounded-xl bg-[#0D1B2A] p-[10px]
              grid-cols-1 auto-rows-[220px]
              md:grid-cols-12 md:grid-rows-[320px_240px] md:auto-rows-auto
            "
          >
            <ImageUploader
              variant="tile"
              imageId="portfolio_1"
              label="Portfolio · Featured 1"
              currentUrl={urlFor('portfolio_1')}
              className="md:col-span-5 md:row-start-1"
            />
            <ImageUploader
              variant="tile"
              imageId="portfolio_2"
              label="Portfolio · Featured 2"
              currentUrl={urlFor('portfolio_2')}
              className="md:col-span-7 md:row-start-1"
            />
            <ImageUploader
              variant="tile"
              imageId="portfolio_3"
              label="Portfolio · Featured 3"
              currentUrl={urlFor('portfolio_3')}
              className="md:col-span-4 md:row-start-2"
            />
            <ImageUploader
              variant="tile"
              imageId="portfolio_4"
              label="Portfolio · Featured 4"
              currentUrl={urlFor('portfolio_4')}
              className="md:col-span-4 md:row-start-2"
            />
            <ImageUploader
              variant="tile"
              imageId="portfolio_5"
              label="Portfolio · Featured 5"
              currentUrl={urlFor('portfolio_5')}
              className="md:col-span-4 md:row-start-2"
            />
          </div>
        </section>
      </main>
    </div>
  );
}
