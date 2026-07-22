/**
 * GET /api/cron/cleanup-abandoned
 *
 * Safety sweep for abandoned checkout holds. Releases any `pending`
 * appointment older than CHECKOUT_HOLD_SECONDS — cancels on Cal.com and
 * flips the row to `canceled_by_system`.
 *
 * Primary release path is still the per-booking QStash delay from
 * `/api/booking/init` plus the checkout-page `/api/booking/release-hold`
 * call when the countdown hits zero. This cron catches closed tabs and
 * failed QStash publishes.
 *
 * Auth: CRON_SECRET via Bearer / X-Cron-Secret / ?cron_secret=
 * (see `lib/cron-auth.ts`). Scheduled daily via `vercel.json` (Hobby plan
 * limit); also safe to call manually when clearing stuck holds.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { CHECKOUT_HOLD_SECONDS } from '@/lib/booking-hold';
import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';
import { releaseAbandonedHoldByCalUid } from '@/lib/release-abandoned-hold';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_SWEEP_BATCH = 50;

interface PendingRow {
  id: string;
  cal_event_id: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = rejectUnlessCronAuthorized(req, 'api/cron/cleanup-abandoned');
  if (gate) return gate;

  let rows: PendingRow[] = [];
  try {
    // Interval math uses seconds so the TEMP 30s hold window works correctly
    // (fractional `CHECKOUT_HOLD_MINUTES` is awkward in PG interval text).
    const { rows: found } = await sql<PendingRow>`
      SELECT id, cal_event_id
      FROM appointments
      WHERE LOWER(COALESCE(status, '')) = 'pending'
        AND created_at < NOW() - (${CHECKOUT_HOLD_SECONDS} || ' seconds')::interval
      ORDER BY created_at ASC
      LIMIT ${MAX_SWEEP_BATCH}
    `;
    rows = found;
  } catch (err) {
    console.error('[api/cron/cleanup-abandoned] select failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  let released = 0;
  let skipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const uid = row.cal_event_id?.trim() ?? '';
    if (!uid) {
      try {
        const { rowCount } = await sql`
          UPDATE appointments
          SET status = 'canceled_by_system'
          WHERE id = ${row.id}::uuid
            AND LOWER(COALESCE(status, '')) = 'pending'
        `;
        if ((rowCount ?? 0) > 0) released += 1;
        else skipped += 1;
      } catch (err) {
        errors.push({ id: row.id, reason: errorMessage(err) });
      }
      continue;
    }

    const result = await releaseAbandonedHoldByCalUid(uid);
    if (!result.ok) {
      errors.push({
        id: row.id,
        reason: result.reason,
      });
      continue;
    }
    if (result.released) released += 1;
    else skipped += 1;
  }

  return NextResponse.json({
    ok: true,
    holdSeconds: CHECKOUT_HOLD_SECONDS,
    scanned: rows.length,
    released,
    skipped,
    errors,
  });
}
