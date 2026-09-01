'use client';

import Link from 'next/link';

import styles from './book.module.css';

export default function BookTopBar({
  showBack = false,
  onBack,
  onHomeClick,
}: {
  showBack?: boolean;
  onBack?: () => void;
  onHomeClick?: () => void;
}) {
  return (
    <header className={styles.topBar}>
      {showBack ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onBack}
          aria-label="Back"
        >
          ←
        </button>
      ) : (
        <span className={styles.iconBtn} aria-hidden="true" />
      )}
      <p className={styles.brand}>Sadie Marie</p>
      <Link
        href="/"
        className={styles.iconBtn}
        aria-label="Home"
        onClick={onHomeClick}
      >
        ✕
      </Link>
    </header>
  );
}
