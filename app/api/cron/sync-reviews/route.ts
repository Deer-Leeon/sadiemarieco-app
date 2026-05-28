/**
 * GET /api/cron/sync-reviews
 *
 * Upstash QStash (or manual curl) pulls Google Places reviews into
 * `google_reviews`. Dedup: UNIQUE (author_name, review_time).
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface GooglePlaceReview {
  author_name: string;
  profile_photo_url?: string;
  rating: number;
  text: string;
  time: number;
}

interface GooglePlaceDetailsResponse {
  status: string;
  error_message?: string;
  result?: {
    reviews?: GooglePlaceReview[];
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authFailure = rejectUnlessCronAuthorized(req, 'api/cron/sync-reviews');
  if (authFailure) return authFailure;

  const placeId = process.env.NEXT_PUBLIC_GOOGLE_PLACE_ID;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placeId || !apiKey) {
    console.error(
      '[api/cron/sync-reviews] NEXT_PUBLIC_GOOGLE_PLACE_ID or GOOGLE_PLACES_API_KEY not set'
    );
    return NextResponse.json(
      { error: 'google_places_not_configured' },
      { status: 503 }
    );
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'reviews');
  url.searchParams.set('key', apiKey);
  // Without this, Google auto-translates reviews (e.g. "cutie!" → "box!").
  url.searchParams.set('reviews_no_translations', 'true');

  let payload: GooglePlaceDetailsResponse;
  try {
    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'google_fetch_failed', message: `HTTP ${upstream.status}` },
        { status: 502 }
      );
    }
    payload = (await upstream.json()) as GooglePlaceDetailsResponse;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/cron/sync-reviews] google fetch failed:', msg);
    return NextResponse.json(
      { error: 'google_fetch_failed', message: msg },
      { status: 502 }
    );
  }

  if (payload.status !== 'OK') {
    console.error('[api/cron/sync-reviews] google status not OK', {
      status: payload.status,
      error_message: payload.error_message,
    });
    return NextResponse.json(
      {
        error: 'google_api_error',
        status: payload.status,
        message: payload.error_message ?? null,
      },
      { status: 502 }
    );
  }

  const reviews = (payload.result?.reviews ?? []).filter(
    (r) => typeof r.text === 'string' && r.text.trim().length > 0
  );

  // Google bumps `time` when a review is edited, so (author_name, review_time)
  // alone won't match the old row. Drop DB rows for each author that are no
  // longer in the current Places payload for that author.
  const timesByAuthor = new Map<string, string[]>();
  for (const review of reviews) {
    const reviewTime = new Date(review.time * 1000);
    if (Number.isNaN(reviewTime.getTime())) continue;
    const iso = reviewTime.toISOString();
    const list = timesByAuthor.get(review.author_name) ?? [];
    list.push(iso);
    timesByAuthor.set(review.author_name, list);
  }

  for (const [authorName, keepTimes] of timesByAuthor) {
    try {
      await sql`
        DELETE FROM google_reviews
        WHERE author_name = ${authorName}
          AND review_time::timestamptz <> ALL(${keepTimes}::timestamptz[])
      `;
    } catch (err) {
      const msg = errorMessage(err);
      console.error('[api/cron/sync-reviews] stale review prune failed', {
        author_name: authorName,
        error: msg,
      });
      return NextResponse.json(
        { error: 'db_prune_failed', message: msg },
        { status: 500 }
      );
    }
  }

  if (reviews.length === 0) {
    return NextResponse.json({
      success: true,
      addedCount: 0,
      updatedCount: 0,
      fetchedCount: 0,
    });
  }

  let addedCount = 0;
  let updatedCount = 0;

  for (const review of reviews) {
    const reviewTime = new Date(review.time * 1000);
    if (Number.isNaN(reviewTime.getTime())) {
      console.warn('[api/cron/sync-reviews] skipping review with invalid time', {
        author_name: review.author_name,
        time: review.time,
      });
      continue;
    }

    try {
      const { rows } = await sql<{ inserted: boolean }>`
        INSERT INTO google_reviews (
          author_name,
          profile_photo_url,
          rating,
          review_text,
          review_time
        )
        VALUES (
          ${review.author_name},
          ${review.profile_photo_url ?? null},
          ${review.rating},
          ${review.text.trim()},
          ${reviewTime.toISOString()}::timestamptz
        )
        ON CONFLICT (author_name, review_time) DO UPDATE SET
          profile_photo_url = EXCLUDED.profile_photo_url,
          rating = EXCLUDED.rating,
          review_text = EXCLUDED.review_text
        RETURNING (xmax = 0) AS inserted
      `;
      const row = rows[0];
      if (!row) continue;
      if (row.inserted) {
        addedCount += 1;
      } else {
        updatedCount += 1;
      }
    } catch (err) {
      const msg = errorMessage(err);
      console.error('[api/cron/sync-reviews] insert failed', {
        author_name: review.author_name,
        error: msg,
      });
      return NextResponse.json(
        { error: 'db_insert_failed', message: msg },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    success: true,
    addedCount,
    updatedCount,
    fetchedCount: reviews.length,
  });
}
