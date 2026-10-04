import type { MetadataRoute } from 'next';

import { loadBookableServices } from '@/lib/book-public';
import { servicePagePath } from '@/lib/seo-service-pages';
import { STUDIO_SITE_URL } from '@/lib/studio-nap';

const LAST_MOD = new Date('2026-08-04');

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const paths = [
    { path: '/', priority: 1, changeFrequency: 'weekly' as const },
    {
      path: '/lash-extensions-lehi',
      priority: 0.9,
      changeFrequency: 'monthly' as const,
    },
    {
      path: '/brow-services-lehi',
      priority: 0.9,
      changeFrequency: 'monthly' as const,
    },
    {
      path: '/beauty-studio-lehi',
      priority: 0.85,
      changeFrequency: 'monthly' as const,
    },
    {
      path: '/areas-we-serve',
      priority: 0.8,
      changeFrequency: 'monthly' as const,
    },
    { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' as const },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' as const },
  ];

  const entries = paths.map(({ path, priority, changeFrequency }) => ({
    // Keep homepage with a trailing slash so it matches the canonical on `/`.
    url: path === '/' ? `${STUDIO_SITE_URL}/` : `${STUDIO_SITE_URL}${path}`,
    lastModified: LAST_MOD,
    changeFrequency,
    priority,
  }));

  try {
    const services = await loadBookableServices();
    for (const service of services) {
      entries.push({
        url: `${STUDIO_SITE_URL}${servicePagePath(service.slug)}`,
        lastModified: LAST_MOD,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  } catch (err) {
    console.warn('[sitemap] service pages unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return entries;
}
