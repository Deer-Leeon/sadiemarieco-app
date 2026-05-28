/**
 * GET /api/cron/sync-reviews
 *
 * Upstash QStash (or manual curl) pulls Google Places reviews into
 * `google_reviews`. Each review is keyed by Google's stable `author_url`
 * so edits (new text, new timestamp) update the same row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface GooglePlaceReview {
  author_name: string;
  author_url?: string;
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
    (r) =>
      typeof r.text === 'string' &&
      r.text.trim().length > 0 &&
      typeof r.author_url === 'string' &&
      r.author_url.trim().length > 0
  );

  if (reviews.length === 0) {
    return NextResponse.json({
      success: true,
      addedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      fetchedCount: 0,
    });
  }

  let addedCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  const authorUrls: string[] = [];

  try {
    const { rowCount: legacyRemoved } = await sql`
      DELETE FROM google_reviews
      WHERE author_url IS NULL
    `;
    removedCount += legacyRemoved ?? 0;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/cron/sync-reviews] legacy cleanup failed', msg);
    return NextResponse.json(
      { error: 'db_cleanup_failed', message: msg },
      { status: 500 }
    );
  }

  for (const review of reviews) {
    const authorUrl = review.author_url!.trim();
    authorUrls.push(authorUrl);

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
          author_url,
          profile_photo_url,
          rating,
          review_text,
          review_time
        )
        VALUES (
          ${review.author_name},
          ${authorUrl},
          ${review.profile_photo_url ?? null},
          ${review.rating},
          ${review.text.trim()},
          ${reviewTime.toISOString()}::timestamptz
        )
        ON CONFLICT (author_url) DO UPDATE SET
          author_name = EXCLUDED.author_name,
          profile_photo_url = EXCLUDED.profile_photo_url,
          rating = EXCLUDED.rating,
          review_text = EXCLUDED.review_text,
          review_time = EXCLUDED.review_time
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
      if (msg.includes('author_url') && msg.includes('does not exist')) {
        console.error(
          '[api/cron/sync-reviews] author_url column missing — run scripts/run-google-reviews-author-url-migration.mjs'
        );
        return NextResponse.json(
          { error: 'db_schema_outdated', message: msg },
          { status: 500 }
        );
      }
      console.error('[api/cron/sync-reviews] upsert failed', {
        author_name: review.author_name,
        error: msg,
      });
      return NextResponse.json(
        { error: 'db_upsert_failed', message: msg },
        { status: 500 }
      );
    }
  }

  try {
    const { rowCount: staleRemoved } = await sql`
      DELETE FROM google_reviews
      WHERE author_url IS NOT NULL
        AND author_url <> ALL(${authorUrls}::text[])
    `;
    removedCount += staleRemoved ?? 0;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[api/cron/sync-reviews] cleanup failed', msg);
    return NextResponse.json(
      { error: 'db_cleanup_failed', message: msg },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    addedCount,
    updatedCount,
    removedCount,
    fetchedCount: reviews.length,
  });
}
