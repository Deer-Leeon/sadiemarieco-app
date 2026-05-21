/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketing site (index.html) and the magic-link booking portal
  // (manage.html) live in /public as static HTML. Next.js does not serve
  // /public/index.html for `/` automatically — it requires an app/page.tsx.
  // Rather than port those pages to React (which would be a substantial
  // rewrite and risks regressing the Cal.com embed + manage.js flow), we
  // rewrite the canonical URLs to the static files. URLs stay clean
  // (the rewrite preserves the path) and the existing site keeps working.
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/manage', destination: '/manage.html' },
    ];
  },
};

export default nextConfig;
