/**
 * GET /api/reviews
 *
 * Public read of synced Google reviews (4–5 stars), newest first.
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const revalidate = 3600;

interface ReviewRow {
  author_name: string;
  profile_photo_url: string | null;
  rating: number;
  review_text: string;
  review_time: Date | string;
}

function serializeDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}

export async function GET(): Promise<NextResponse> {
  try {
    const { rows } = await sql<ReviewRow>`
      SELECT
        author_name,
        profile_photo_url,
        rating,
        review_text,
        review_time
      FROM google_reviews
      WHERE rating >= 4
      ORDER BY review_time DESC
    `;

    const reviews = rows.map((row) => ({
      author_name: row.author_name,
      profile_photo_url: row.profile_photo_url,
      rating: row.rating,
      text: row.review_text,
      review_time: serializeDate(row.review_time),
    }));

    return NextResponse.json({ reviews });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/reviews] query failed:', message);
    return NextResponse.json(
      { error: 'reviews_fetch_failed', message },
      { status: 500 }
    );
  }
}
