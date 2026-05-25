/**
 * /api/admin/clients/[id]/notes
 *
 * GET   — fetch private admin notes for a client.
 * PATCH — upsert notes text (body: { notes: string }).
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function clientExists(id: string): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS(SELECT 1 FROM clients WHERE id = ${id}::uuid) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

export async function GET(
  _req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    if (!(await clientExists(id))) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const { rows } = await sql<{
      notes: string;
      updated_at: Date | string | null;
    }>`
      SELECT notes, updated_at
      FROM client_notes
      WHERE client_id = ${id}::uuid
      LIMIT 1
    `;

    const row = rows[0];
    return NextResponse.json({
      notes: row?.notes ?? '',
      updated_at: serializeDate(row?.updated_at ?? null),
    });
  } catch (err) {
    console.error('[api/admin/clients/[id]/notes] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!raw || typeof raw !== 'object' || !('notes' in raw)) {
    return NextResponse.json({ error: 'missing_notes' }, { status: 400 });
  }

  const notes =
    typeof (raw as { notes: unknown }).notes === 'string'
      ? (raw as { notes: string }).notes
      : '';

  try {
    if (!(await clientExists(id))) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const { rows } = await sql<{
      notes: string;
      updated_at: Date | string;
    }>`
      INSERT INTO client_notes (client_id, notes, updated_at)
      VALUES (${id}::uuid, ${notes}, NOW())
      ON CONFLICT (client_id) DO UPDATE SET
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING notes, updated_at
    `;

    return NextResponse.json({
      notes: rows[0].notes,
      updated_at: serializeDate(rows[0].updated_at),
    });
  } catch (err) {
    console.error('[api/admin/clients/[id]/notes] PATCH failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_upsert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
