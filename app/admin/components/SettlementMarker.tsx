'use client';

import { Check, DollarSign, Heart } from 'lucide-react';

import {
  isAppointmentSettled,
  settlementShortLabel,
} from '../settlementDisplay';
import type { TerminalPaymentSummary } from '../types';

/**
 * Tiny settled marker for dense calendar pills (3-day / week / month /
 * day popup). A check answers "is this done?"; method is available via
 * title/aria for Cash and Comped.
 */
export function SettlementCheckMarker({
  payment,
  className = '',
  size = 'sm',
}: {
  payment: TerminalPaymentSummary | null | undefined;
  className?: string;
  size?: 'sm' | 'md';
}) {
  if (!isAppointmentSettled(payment)) return null;

  const label = settlementShortLabel(payment?.payment_kind);
  const Icon =
    payment?.payment_kind === 'cash'
      ? DollarSign
      : payment?.payment_kind === 'complimentary'
        ? Heart
        : Check;
  const iconClass = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const boxClass =
    size === 'md'
      ? 'h-4 w-4'
      : 'h-3.5 w-3.5';

  return (
    <span
      className={`pointer-events-none inline-flex items-center justify-center rounded-sm bg-emerald-50/95 text-emerald-800 shadow-sm ${boxClass} ${className}`}
      title={label}
      aria-label={label}
    >
      <Icon className={iconClass} strokeWidth={2.6} aria-hidden="true" />
    </span>
  );
}

/**
 * Text badge for list rows and other roomier surfaces.
 */
export function SettlementBadge({
  payment,
  className = '',
}: {
  payment: TerminalPaymentSummary | null | undefined;
  className?: string;
}) {
  if (!isAppointmentSettled(payment)) return null;

  const label = settlementShortLabel(payment?.payment_kind);
  const Icon =
    payment?.payment_kind === 'cash'
      ? DollarSign
      : payment?.payment_kind === 'complimentary'
        ? Heart
        : Check;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 ${className}`}
      title={label}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2.4} aria-hidden="true" />
      {label}
    </span>
  );
}
