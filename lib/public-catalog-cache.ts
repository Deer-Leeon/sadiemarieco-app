/**
 * Data-cache wrapper for the read-only catalogue the public site shows
 * (homepage images + services, `/book` service list).
 *
 * Neon suspends after 5 idle minutes and every query wakes it for at least
 * another 5, so a homepage visit should not touch Postgres. Rows are cached
 * under one tag; every admin write path calls `refreshPublicCatalog()` so
 * edits still appear on the next page load. The long revalidate is only a
 * backstop for writes made outside the app (SQL scripts, Neon console).
 *
 * Loaders passed to `cachedPublicCatalog` must throw on failure — a caught
 * error returning `[]` would be cached as an empty menu for hours.
 */

import { revalidateTag, unstable_cache } from 'next/cache';

export const PUBLIC_CATALOG_TAG = 'public-catalog';

const PUBLIC_CATALOG_REVALIDATE_SECONDS = 6 * 60 * 60;

export function cachedPublicCatalog<T>(
  key: string,
  load: () => Promise<T>
): () => Promise<T> {
  return unstable_cache(load, [PUBLIC_CATALOG_TAG, key], {
    tags: [PUBLIC_CATALOG_TAG],
    revalidate: PUBLIC_CATALOG_REVALIDATE_SECONDS,
  });
}

/**
 * Call after any write to `site_services` or `site_images`. Route handlers
 * call it directly; Server Components must wrap it in `after()`.
 */
export function refreshPublicCatalog(): void {
  try {
    revalidateTag(PUBLIC_CATALOG_TAG, { expire: 0 });
  } catch (err) {
    console.warn('[public-catalog] revalidate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}