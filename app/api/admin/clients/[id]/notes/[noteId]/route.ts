/**
 * PATCH /api/admin/clients/[id]/notes/[noteId]
 *
 * Toggle or set `is_pinned` on a single historical note.
 * Body (optional): { is_pinned: boolean } — when omitted, flips the current value.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { ClientNote } from '@/app/admin/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string; noteId: string }>;
}

interface NoteRow {
  id: number;
  client_id: string;
  notes: string;
  is_pinned: boolean;
  created_at: Date | string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeDate(value: Date | string | null): string {
  const d = value instanceof Date ? value : new Date(value ?? '');
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function rowToNote(row: NoteRow): ClientNote {
  return {
    id: row.id,
    client_id: row.client_id,
    notes: row.notes,
    is_pinned: Boolean(row.is_pinned),
    created_at: serializeDate(row.created_at),
  };
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

  const { id, noteId: noteIdRaw } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const noteId = Number(noteIdRaw);
  if (!Number.isInteger(noteId) || noteId <= 0) {
    return NextResponse.json({ error: 'invalid_note_id' }, { status: 400 });
  }

  let desiredPinned: boolean | null = null;
  try {
    const raw = await req.json();
    if (raw && typeof raw === 'object' && 'is_pinned' in raw) {
      const value = (raw as { is_pinned: unknown }).is_pinned;
      if (typeof value !== 'boolean') {
        return NextResponse.json({ error: 'invalid_is_pinned' }, { status: 400 });
      }
      desiredPinned = value;
    }
  } catch {
    // Empty body — flip current value.
  }

  try {
    if (desiredPinned === null) {
      const { rows } = await sql<NoteRow>`
        UPDATE client_notes
        SET is_pinned = NOT is_pinned
        WHERE id = ${noteId}
          AND client_id = ${id}::uuid
        RETURNING id, client_id, notes, is_pinned, created_at
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      return NextResponse.json({ note: rowToNote(rows[0]) });
    }

    const { rows } = await sql<NoteRow>`
      UPDATE client_notes
      SET is_pinned = ${desiredPinned}
      WHERE id = ${noteId}
        AND client_id = ${id}::uuid
      RETURNING id, client_id, notes, is_pinned, created_at
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ note: rowToNote(rows[0]) });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/notes/[noteId]] PATCH failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
