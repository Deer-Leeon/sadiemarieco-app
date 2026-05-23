/**
 * /api/admin/clients/[id]
 *
 * Per-client read + update endpoint. The list-level operations
 * (GET by phone, POST first-touch upsert) live one level up in
 * /api/admin/clients/route.ts — this file is for things that need
 * the UUID to be in the URL path.
 *
 * Methods:
 *   GET     Fetch the client by UUID. 404 when not found.
 *           ClientProfileModal uses this for "refresh after edit"
 *           when it wants to make sure the local copy still matches
 *           the DB.
 *
 *   PATCH   { first_name?, last_name?, email? }
 *           Update profile fields. Phone is intentionally NOT
 *           PATCHable here — it's the unique identifier and changing
 *           it would invalidate the URL the admin is sitting on. If
 *           a phone correction is ever needed, expect the admin to
 *           create a new client + merge, not mutate in place.
 *
 * Auth: requireAdminUser (same gate as the list endpoint).
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Client } from '@/app/admin/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ClientRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: string | null;
}

function rowToClient(row: ClientRow): Client {
  return {
    id: row.id,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    created_at: row.created_at,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitiseName(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined; // not present in patch
  if (raw === null) return null; // explicitly cleared
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitiseEmail(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Cheap UUID format check so we can short-circuit obviously-malformed
// URLs with a 400 instead of letting Postgres throw on the cast.
// Standard 8-4-4-4-12 hex pattern with optional braces — the live
// `gen_random_uuid()` output always matches this.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  // Next 15 made route params async — they arrive as a Promise. Awaiting
  // before use is required (we destructure inside the handler).
  params: Promise<{ id: string }>;
}

// ─── GET ────────────────────────────────────────────────────────────────────
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
    const { rows } = await sql<ClientRow>`
      SELECT id, phone, first_name, last_name, email, created_at
      FROM clients
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ client: rowToClient(rows[0]) });
  } catch (err) {
    console.error('[api/admin/clients/[id]] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

// ─── PATCH ──────────────────────────────────────────────────────────────────
//
// Editable fields: first_name, last_name, email. Phone is excluded
// (see file header). We support partial patches — only the keys
// present in the body get touched. `null` in the body explicitly
// clears the field (vs. `undefined` / missing which leaves it alone).
//
// COALESCE pattern: each column is set to COALESCE($newValue, column)
// when we want "update only if provided", but to a literal NULL when
// the admin clears it. So we resolve the three-state input
// (undefined / null / string) up front and only include columns
// that need to change in the SET clause.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const nextFirst = sanitiseName(payload.first_name);
  const nextLast = sanitiseName(payload.last_name);
  const nextEmail = sanitiseEmail(payload.email);

  const changedFirst = nextFirst !== undefined;
  const changedLast = nextLast !== undefined;
  const changedEmail = nextEmail !== undefined;

  if (!changedFirst && !changedLast && !changedEmail) {
    return NextResponse.json(
      { error: 'no_fields', hint: 'pass at least one of first_name, last_name, email' },
      { status: 400 }
    );
  }

  // We resolve the SQL with three independent CASE-style coalesces
  // rather than dynamic statement-building. @vercel/postgres' tagged
  // template hands every interpolation through as a parameter, so
  // this stays parameterised end-to-end. The COALESCE($val, column)
  // pattern leaves the column alone when $val is the special "no
  // change" sentinel we pass in for keys not in the body.
  //
  // Sentinel design: use a JSON-style "leave alone" approach by
  // passing an array literal of two elements that PG can't ever
  // match to a real value — actually simpler to just write three
  // mini-updates conditionally. The PG driver doesn't support
  // statement building well from tagged templates, so we branch by
  // bitmask. Three booleans → 7 possible non-empty combinations;
  // each one inlined keeps the SQL legible and the explain plan
  // boring.
  try {
    let updated: ClientRow[] = [];
    if (changedFirst && changedLast && changedEmail) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET first_name = ${nextFirst},
            last_name = ${nextLast},
            email = ${nextEmail}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedFirst && changedLast) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET first_name = ${nextFirst}, last_name = ${nextLast}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedFirst && changedEmail) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET first_name = ${nextFirst}, email = ${nextEmail}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedLast && changedEmail) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET last_name = ${nextLast}, email = ${nextEmail}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedFirst) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET first_name = ${nextFirst}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedLast) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET last_name = ${nextLast}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    } else if (changedEmail) {
      ({ rows: updated } = await sql<ClientRow>`
        UPDATE clients
        SET email = ${nextEmail}
        WHERE id = ${id}::uuid
        RETURNING id, phone, first_name, last_name, email, created_at
      `);
    }

    if (updated.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ client: rowToClient(updated[0]) });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes('clients_email_key')) {
      return NextResponse.json(
        {
          error: 'email_in_use',
          message:
            'Another client already has this email on file. Pick a different one or merge the records.',
        },
        { status: 409 }
      );
    }
    console.error('[api/admin/clients/[id]] PATCH failed:', msg);
    return NextResponse.json(
      { error: 'db_update_failed', message: msg },
      { status: 500 }
    );
  }
}
