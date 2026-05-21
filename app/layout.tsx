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
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
