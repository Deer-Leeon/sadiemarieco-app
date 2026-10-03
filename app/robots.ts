import type { MetadataRoute } from 'next';

import { STUDIO_SITE_URL } from '@/lib/studio-nap';

/** AI training crawlers and SEO-tool scrapers; `proxy.ts` also 403s them. */
const BLOCKED_CRAWLERS = [
  'GPTBot',
  'CCBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'Amazonbot',
  'meta-externalagent',
  'FacebookBot',
  'cohere-ai',
  'Diffbot',
  'omgili',
  'ImagesiftBot',
  'Timpibot',
  'YouBot',
  'AI2Bot',
  'AhrefsBot',
  'SemrushBot',
  'MJ12bot',
  'DotBot',
  'BLEXBot',
  'PetalBot',
  'DataForSeoBot',
  'Barkrowler',
  'serpstatbot',
  'Baiduspider',
  'Sogou',
];

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
          '/book',
          '/checkout',
          '/consent/',
          '/manage',
          '/manage.html',
          '/sign-in',
        ],
      },
      {
        userAgent: BLOCKED_CRAWLERS,
        disallow: '/',
      },
    ],
    sitemap: `${STUDIO_SITE_URL}/sitemap.xml`,
    host: STUDIO_SITE_URL,
  };
}
