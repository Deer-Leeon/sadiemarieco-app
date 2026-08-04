import type { MetadataRoute } from 'next';

import { STUDIO_SITE_URL } from '@/lib/studio-nap';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/admin/',
          '/api/',
          '/checkout',
          '/consent/',
          '/manage',
          '/manage.html',
          '/sign-in',
        ],
      },
    ],
    sitemap: `${STUDIO_SITE_URL}/sitemap.xml`,
    host: STUDIO_SITE_URL,
  };
}
