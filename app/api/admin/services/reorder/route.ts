/**
 * PUT /api/admin/services/reorder
 *
 * Bulk-update display_order from a full ordered id list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { gateAdmin } from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ReorderBody {
  orderedIds?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  if (!raw || typeof raw !== 'object') {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be a JSON object' },
      { status: 400 }
    );
  }

  const body = raw as ReorderBody;
  if (!Array.isArray(body.orderedIds)) {
    return NextResponse.json(
      {
        error: 'invalid_ordered_ids',
        message: 'orderedIds must be an array of service ids',
      },
      { status: 400 }
    );
  }

  const orderedIds: number[] = [];
  const seen = new Set<number>();
  for (const item of body.orderedIds) {
    const id =
      typeof item === 'number'
        ? item
        : typeof item === 'string'
          ? Number(item)
          : NaN;
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json(
        {
          error: 'invalid_ordered_ids',
          message: 'Each orderedIds entry must be a positive integer',
        },
        { status: 400 }
      );
    }
    if (seen.has(id)) {
      return NextResponse.json(
        {
          error: 'duplicate_id',
          message: `Duplicate service id ${id} in orderedIds`,
        },
        { status: 400 }
      );
    }
    seen.add(id);
    orderedIds.push(id);
  }

  let activeIds: number[];
  try {
    const { rows } = await sql<{ id: number }>`
      SELECT id FROM site_services WHERE is_active = TRUE ORDER BY id ASC
    `;
    activeIds = rows.map((r) => r.id);
  } catch (err) {
    console.error('[api/admin/services/reorder] active scan failed:', err);
    return NextResponse.json(
      { error: 'db_read_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  if (orderedIds.length !== activeIds.length) {
    return NextResponse.json(
      {
        error: 'incomplete_order',
        message: `orderedIds must include every active service exactly once (expected ${activeIds.length}, got ${orderedIds.length})`,
      },
      { status: 400 }
    );
  }

  const activeSet = new Set(activeIds);
  for (const id of orderedIds) {
    if (!activeSet.has(id)) {
      return NextResponse.json(
        {
          error: 'unknown_id',
          message: `Service id ${id} is not an active row`,
        },
        { status: 400 }
      );
    }
  }

  try {
    await sql.query(
      `
        UPDATE site_services AS s
        SET display_order = u.ord
        FROM unnest($1::int[], $2::int[]) AS u(id, ord)
        WHERE s.id = u.id
      `,
      [orderedIds, orderedIds.map((_, index) => index)]
    );
  } catch (err) {
    console.error('[api/admin/services/reorder] bulk update failed:', err);
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, count: orderedIds.length });
}
