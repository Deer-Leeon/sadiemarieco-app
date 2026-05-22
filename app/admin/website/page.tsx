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
 * Catalogue of editable image slots.
 *
 * `id` must match the `site_images.id` primary key AND survive the
 * server-side regex in /api/upload (`^[a-zA-Z0-9_-]{1,64}$`). Add new
 * slots here; the page picks them up automatically.
 *
 * Keeping this in a typed array (not just JSX) gives us a single place
 * to add slots and means we can later auto-generate sitemaps, alt-text
 * templates, image-replacement workflows, etc. without splitting truth
 * across the template.
 */
const IMAGE_SLOTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'home_hero', label: 'Homepage Hero Image' },
  { id: 'about_profile', label: 'About Section Portrait' },
  { id: 'portfolio_1', label: 'Portfolio · Featured 1' },
  { id: 'portfolio_2', label: 'Portfolio · Featured 2' },
  { id: 'portfolio_3', label: 'Portfolio · Featured 3' },
  { id: 'services_lashes', label: 'Lash Services · Cover' },
];

export default async function WebsiteEditorPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Same allowlist as the main dashboard. Middleware enforces "signed in"
  // for /admin/**, this gate enforces "signed in AND on the allowlist".
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  // ── DATA FETCH ────────────────────────────────────────────────────────
  // Single unfiltered SELECT — the @vercel/postgres `sql` tagged template
  // doesn't accept array params (e.g. `WHERE id = ANY(${ids})` fails type-
  // check), and a CMS image table will only ever hold a few dozen rows.
  // Cheaper to filter client-side than to build a raw query string for
  // such a small table. We construct the lookup map from rows whose id
  // matches our `IMAGE_SLOTS` catalogue so stale rows don't render and
  // unknown ones don't take memory.
  let imageMap: Record<string, string> = {};
  let dbError: string | null = null;
  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url FROM site_images
    `;
    const knownIds = new Set(IMAGE_SLOTS.map((s) => s.id));
    imageMap = Object.fromEntries(
      rows.filter((r) => knownIds.has(r.id)).map((r) => [r.id, r.image_url])
    );
  } catch (err) {
    console.error('[admin/website] site_images query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

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

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {IMAGE_SLOTS.map((slot) => (
            <ImageUploader
              key={slot.id}
              imageId={slot.id}
              label={slot.label}
              currentUrl={imageMap[slot.id] ?? null}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
