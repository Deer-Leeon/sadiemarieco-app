import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sadie Marie',
  description: 'Sadie Marie Beauty Studio',
};

/**
 * Root layout for the Next.js portion of the site (currently just /admin).
 *
 * Important: this layout does NOT wrap /, /index.html, or /manage.html —
 * those are served directly from /public as static HTML and bypass the
 * Next.js render tree entirely. ClerkProvider here only affects routes
 * that resolve through the App Router (i.e. /admin and any future
 * Next.js routes we add).
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
      <html lang="en">
        <head>
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
            href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,600;0,6..96,700;1,6..96,400;1,6..96,600&family=DM+Sans:wght@200;300;400;500&display=swap"
            rel="stylesheet"
          />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
