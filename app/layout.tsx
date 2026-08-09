import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

import {
  SEO_DEFAULT_DESCRIPTION,
  SEO_DEFAULT_TITLE,
} from '@/lib/seo-meta';
import { STUDIO_OG_IMAGE_URL, STUDIO_SITE_URL } from '@/lib/studio-nap';

export const metadata: Metadata = {
  metadataBase: new URL(STUDIO_SITE_URL),
  title: {
    default: SEO_DEFAULT_TITLE,
    template: '%s · Sadie Marie',
  },
  description: SEO_DEFAULT_DESCRIPTION,
  openGraph: {
    siteName: 'Sadie Marie',
    images: [{ url: STUDIO_OG_IMAGE_URL, width: 1200, height: 630 }],
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/assets/brand/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/assets/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/assets/brand/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

/**
 * Root layout for the Next.js portion of the site (currently just /admin).
 *
 * Important: this layout does NOT wrap /, /index.html, or /manage.html —
 * those are served directly from /public as static HTML and bypass the
 * Next.js render tree entirely. ClerkProvider here only affects routes
 * that resolve through the App Router (i.e. /admin and any future
 * Next.js routes we add). Marketing HTML (`/`, SEO landings, etc.) gets
 * Analytics/Speed Insights via scripts in those static files.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      // Lock the sign-in flow to our in-app page rather than Clerk's
      // hosted accounts URL. The middleware reads this when calling
      // auth.protect() on /admin to know where to send unauthenticated
      // users. Keeping it in source (vs an env var) means a missing
      // NEXT_PUBLIC_CLERK_SIGN_IN_URL can never accidentally route
      // admins to a Clerk-branded page.
      signInUrl="/sign-in"
      signInFallbackRedirectUrl="/admin"
    >
      <html lang="en" style={{ colorScheme: 'light' }}>
        <head>
          <meta name="color-scheme" content="light" />
          {/*
            Loads the same Bodoni Moda + DM Sans family the public site
            (public/index.html) uses, so the admin dashboard renders with
            the studio's actual typography rather than the Georgia /
            system-sans fallbacks declared in globals.css's @theme block.
            Kept as a plain <link> rather than `next/font` to mirror the
            public site exactly and to avoid the build-time CSS-variable
            override that `next/font` would impose on our @theme tokens.
          */}
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossOrigin=""
          />
          <link
            href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,600;0,6..96,700;1,6..96,400;1,6..96,600&family=DM+Sans:wght@200;300;400;500&family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&display=swap"
            rel="stylesheet"
          />
        </head>
        <body>
          {children}
          <Analytics />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
