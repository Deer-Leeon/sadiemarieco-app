/**
 * GET /api/services
 *
 * Public, read-only JSON catalogue for native clients (iOS). Mirrors the
 * `site_services` query and sort used by `fetchServicesHtml()` in
 * `app/route.ts` — same WHERE/ORDER BY, plus `display_order` for clients
 * that rebuild grouping locally.
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { CAL_USERNAME } from '@/lib/cal-embed-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Keep in sync with `PUBLIC_CATEGORY_COLUMN_RANK` in app/route.ts */
const CATEGORY_COLUMN_RANK: Record<string, number> = {
  'Lash Services': 0,
  'Brow Services': 1,
  'Teeth Whitening': 2,
};

/** Keep in sync with `COMING_SOON_CATEGORIES` in app/route.ts */
const COMING_SOON_CATEGORIES = ['Teeth Whitening'] as const;

/** Keep in sync with `COMING_SOON_HOST_CATEGORY` in app/route.ts */
const COMING_SOON_HOST_CATEGORY: Record<string, string> = {
  'Teeth Whitening': 'Brow Services',
};

interface PublicServiceRow {
  id: number;
  category: string;
  title: string;
  description: string;
  price: string;
  duration_mins: number | null;
  slug: string | null;
  is_group: boolean;
  parent_id: number | null;
  display_order: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(): Promise<NextResponse> {
  try {
    const { rows } = await sql<PublicServiceRow>`
      SELECT
        id,
        category,
        title,
        description,
        price,
        duration_mins,
        slug,
        is_group,
        parent_id,
        display_order
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC
    `;

    const services = rows.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      description: row.description,
      price: Number(row.price),
      duration_mins: row.duration_mins,
      slug: row.slug,
      is_group: row.is_group,
      parent_id: row.parent_id,
      display_order: row.display_order,
    }));

    const calUsername = process.env.CAL_USERNAME?.trim() || CAL_USERNAME;

    return NextResponse.json(
      {
        calUsername,
        layout: {
          categoryColumnRank: CATEGORY_COLUMN_RANK,
          comingSoonCategories: [...COMING_SOON_CATEGORIES],
          comingSoonHostCategory: COMING_SOON_HOST_CATEGORY,
        },
        services,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  } catch (err) {
    console.error('[api/services] query failed:', err);
    return NextResponse.json(
      { error: 'db_query_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
