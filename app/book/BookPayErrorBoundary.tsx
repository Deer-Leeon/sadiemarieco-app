'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './book.module.css';

type Props = {
  priceLabel: string;
  onPayWithCard: () => void;
  submitting: boolean;
  children: ReactNode;
};

type State = { crashed: boolean };

/**
 * If Stripe Express Checkout throws while mounting, keep the card path
 * usable instead of white-screening /book.
 */
export default class BookPayErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[book] review pay UI crashed', {
      error: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.crashed) {
      const { priceLabel, onPayWithCard, submitting } = this.props;
      return (
        <footer className={`${styles.footer} ${styles.footerStack}`}>
          <div className={styles.footerTotal}>
            <span className={styles.footerPrice}>{priceLabel}</span>
            <span className={styles.footerHint}>Then secure checkout</span>
          </div>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={submitting}
            onClick={onPayWithCard}
          >
            {submitting ? 'Holding your time…' : 'Continue to checkout'}
          </button>
        </footer>
      );
    }
    return this.props.children;
  }
}
