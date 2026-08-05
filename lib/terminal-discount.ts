/**
 * Staff-selected amount overrides before a Stripe Terminal charge.
 * Tips are still collected on the reader against the charged base.
 */

export const TERMINAL_DISCOUNT_PERCENTS = [0, 10, 20, 50] as const;

export type TerminalDiscountPercent =
  (typeof TERMINAL_DISCOUNT_PERCENTS)[number];

/** Soft ceiling to catch typos — $10,000. */
export const TERMINAL_CUSTOM_AMOUNT_MAX_CENTS = 1_000_000;

export function isTerminalDiscountPercent(
  value: unknown
): value is TerminalDiscountPercent {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (TERMINAL_DISCOUNT_PERCENTS as readonly number[]).includes(value)
  );
}

/** Charge amount after percent discount, rounded to the nearest cent. */
export function applyTerminalDiscount(
  quotedCents: number,
  percent: TerminalDiscountPercent
): number {
  if (!Number.isSafeInteger(quotedCents) || quotedCents < 0) return 0;
  if (percent === 0) return quotedCents;
  return Math.round((quotedCents * (100 - percent)) / 100);
}

export function isValidTerminalCustomAmountCents(
  value: unknown
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 50 &&
    value <= TERMINAL_CUSTOM_AMOUNT_MAX_CENTS
  );
}

export function terminalDiscountNote(
  percent: TerminalDiscountPercent
): string | null {
  if (percent === 0) return null;
  return `${percent}% service discount applied before Terminal charge`;
}

export function terminalCustomAmountNote(
  customCents: number,
  quotedCents: number
): string {
  return `Custom charge ${formatCentsForNote(customCents)} (quoted ${formatCentsForNote(quotedCents)})`;
}

function formatCentsForNote(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Parse a dollars input like "70", "70.5", "$70.00" into cents. */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/\$/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function formatCentsAsDollarInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return '';
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}
