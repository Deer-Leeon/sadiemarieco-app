/**
 * Postgres-backed fixed-window rate limiter for public write APIs.
 * Fail-open on DB errors so a missing migration never bricks booking.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export function clientIpFromRequest(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp.slice(0, 128);
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf.slice(0, 128);
  return 'unknown';
}

function windowStartIso(windowMs: number): string {
  const now = Date.now();
  const startMs = Math.floor(now / windowMs) * windowMs;
  return new Date(startMs).toISOString();
}

/**
 * @returns `null` when allowed; otherwise a 429 NextResponse.
 */
export async function rejectUnlessRateAllowed(options: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<NextResponse | null> {
  const key = options.key.slice(0, 200);
  if (!key || options.limit < 1 || options.windowMs < 1000) {
    return null;
  }

  const windowStart = windowStartIso(options.windowMs);

  try {
    const { rows } = await sql<{ hit_count: number }>`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, hit_count)
      VALUES (${key}, ${windowStart}::timestamptz, 1)
      ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET hit_count = rate_limit_buckets.hit_count + 1
      RETURNING hit_count
    `;
    const count = Number(rows[0]?.hit_count ?? 0);
    if (count > options.limit) {
      const retryAfterSec = Math.max(1, Math.ceil(options.windowMs / 1000));
      return NextResponse.json(
        {
          error: 'rate_limited',
          message: 'Too many requests. Please wait a moment and try again.',
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSec) },
        }
      );
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Table missing / transient Neon blip — never block the booking path.
    console.warn('[rate-limit] check failed (allowing request):', message);
    return null;
  }
}

export const RATE_LIMITS = {
  bookingInit: { limit: 30, windowMs: 60_000 },
  bookingConfirm: { limit: 30, windowMs: 60_000 },
  bookingReleaseHold: { limit: 30, windowMs: 60_000 },
  stripeSetupIntent: { limit: 20, windowMs: 60_000 },
  consentPost: { limit: 10, windowMs: 15 * 60_000 },
  consentPatch: { limit: 30, windowMs: 15 * 60_000 },
  consentPreview: { limit: 30, windowMs: 15 * 60_000 },
} as const;
