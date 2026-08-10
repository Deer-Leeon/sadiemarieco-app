/**
 * Shared helpers for the public phone booker (`/book` + `/api/book/*`).
 */

import { sql } from '@vercel/postgres';

export interface BookableService {
  slug: string;
  title: string;
  category: string;
  description: string | null;
  price: string;
  priceLabel: string;
  priceCents: number;
  durationMins: number;
  durationLabel: string;
  calEventId: number;
}

function formatPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return `$${price}`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Dollars string from DB → integer cents for Stripe / Apple Pay. */
export function priceToCents(price: string): number {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return h === 1 ? '60 min' : `${h * 60} min`;
  return `${mins} min`;
}

export async function loadBookableServices(): Promise<BookableService[]> {
  const { rows } = await sql<{
    slug: string;
    title: string;
    category: string;
    description: string | null;
    price: string;
    duration_mins: number;
    cal_event_id: number;
  }>`
    SELECT
      slug,
      title,
      category,
      description,
      price::text AS price,
      duration_mins,
      cal_event_id
    FROM site_services
    WHERE is_active = TRUE
      AND is_group = FALSE
      AND cal_event_id IS NOT NULL
      AND slug IS NOT NULL
      AND duration_mins IS NOT NULL
      AND duration_mins > 0
    ORDER BY display_order ASC, id ASC
  `;

  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    category: row.category || 'Services',
    description: row.description,
    price: row.price,
    priceLabel: formatPrice(row.price),
    priceCents: priceToCents(row.price),
    durationMins: row.duration_mins,
    durationLabel: formatDuration(row.duration_mins),
    calEventId: row.cal_event_id,
  }));
}

export async function loadBookableServiceBySlug(
  slug: string
): Promise<BookableService | null> {
  const clean = slug.trim().toLowerCase();
  if (!clean) return null;
  const services = await loadBookableServices();
  return (
    services.find((s) => s.slug.toLowerCase() === clean) ??
    services.find((s) => s.slug === slug.trim()) ??
    null
  );
}

/** Phone viewport heuristic for homepage → /book handoff. */
export const BOOK_PHONE_MAX_WIDTH_PX = 768;
