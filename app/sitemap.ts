import type { MetadataRoute } from 'next';

import { STUDIO_SITE_URL } from '@/lib/studio-nap';

const LAST_MOD = new Date('2026-08-04');

export default function sitemap(): MetadataRoute.Sitemap {
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

  return paths.map(({ path, priority, changeFrequency }) => ({
    // Keep homepage with a trailing slash so it matches the canonical on `/`.
    url: path === '/' ? `${STUDIO_SITE_URL}/` : `${STUDIO_SITE_URL}${path}`,
    lastModified: LAST_MOD,
    changeFrequency,
    priority,
  }));
}
