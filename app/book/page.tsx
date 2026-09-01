import { Suspense } from 'react';

import BookClient from './BookClient';
import BookTopBar from './BookTopBar';
import styles from './book.module.css';

export const metadata = {
  title: 'Book',
  description: 'Book a lash or brow appointment with Sadie Marie in Lehi, UT.',
  robots: { index: false, follow: false },
};

export default function BookPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.shell}>
          <BookTopBar />
        </div>
      }
    >
      <BookClient />
    </Suspense>
  );
}
