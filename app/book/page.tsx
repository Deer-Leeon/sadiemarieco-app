import { Suspense } from 'react';

import BookClient from './BookClient';

export const metadata = {
  title: 'Book',
  description: 'Book a lash or brow appointment with Sadie Marie in Lehi, UT.',
  robots: { index: false, follow: false },
};

export default function BookPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100dvh',
            display: 'grid',
            placeItems: 'center',
            background: '#F5F3F0',
            color: '#586574',
            fontFamily: 'DM Sans, system-ui, sans-serif',
            fontSize: 14,
          }}
        >
          Opening booking…
        </div>
      }
    >
      <BookClient />
    </Suspense>
  );
}
