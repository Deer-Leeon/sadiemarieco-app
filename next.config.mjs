/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Server-only native packages ────────────────────────────────────────
  // `sharp` ships a native libvips binary that Next.js must not attempt to
  // bundle into the server build — it has to be loaded from node_modules at
  // runtime instead. We rely on sharp inside `app/api/upload/route.ts` to
  // re-encode every uploaded image into sRGB (see the comment in that
  // file). Next.js auto-externalises sharp in most versions, but listing
  // it explicitly is the documented future-proof way and a no-op when the
  // auto-detection already handled it.
  serverExternalPackages: ['sharp'],

  // Consent PDF stamping embeds EB Garamond from disk at runtime.
  outputFileTracingIncludes: {
    '/api/consent/[clientId]': ['./public/fonts/**/*', './assets/fonts/**/*'],
  },

  // ── Image domain allowlist ─────────────────────────────────────────────
  // Any `<Image>` from next/image whose `src` points to Vercel Blob
  // storage must be on this allowlist or Next.js will reject it at build
  // time. The marketing page itself uses plain <img> tags (so this isn't
  // strictly required for the public site today), but the admin /admin/
  // surfaces and any future React-rendered pages will rely on this.
  //
  // The wildcard matches all blob stores under our Vercel project — the
  // URL shape is `https://{storeId}.public.blob.vercel-storage.com/...`.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com',
      },
    ],
  },

  // ── Static page rewrites ───────────────────────────────────────────────
  // The booking management portal (manage.html) lives in /public as a
  // static HTML file. We rewrite `/manage` to it so the URL stays clean
  // while preserving the existing manage.js + Cal.com embed flow.
  //
  // NOTE: We DELIBERATELY do not rewrite `/` here anymore. The homepage
  // is now served by `app/route.ts`, which reads public/index.html from
  // disk, substitutes CMS image URLs from the `site_images` Postgres
  // table, and returns the modified HTML. Adding a `/` → `/index.html`
  // rewrite would take precedence over the route handler and serve the
  // raw (pre-substitution) HTML.
  async rewrites() {
    return [
      { source: '/manage', destination: '/manage.html' },
    ];
  },
};

export default nextConfig;
