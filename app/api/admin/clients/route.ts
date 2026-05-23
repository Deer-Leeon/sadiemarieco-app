/**
 * /api/admin/clients
 *
 * The phone-keyed CRM entry point. The admin Client CRM treats a
 * client's normalised (digits-only) phone number as the unique
 * identifier — see scripts/migrate_clients.sql for the schema
 * decisions backing that choice.
 *
 * Methods:
 *   GET  ?phone=...        Read-only fetch by normalised phone.
 *                          404 when no row matches. No write side-
 *                          effect (use POST for first-touch upsert).
 *
 *   POST { phone, first_name?, last_name?, email? }
 *                          First-Touch Lock-in upsert: insert keyed
 *                          by normalised phone; on conflict, return
 *                          the EXISTING row UNTOUCHED. This is what
 *                          ClientProfileModal calls on mount so the
 *                          admin can drill into a brand-new client
 *                          without an explicit "create" step.
 *
 * PATCH lives on /api/admin/clients/[id]/route.ts — keeps the id in
 * the URL for cleaner request shape and lets per-client routes share
 * a common path prefix.
 *
 * Defence-in-depth: every method requires an admin-allowlisted Clerk
 * session via requireAdminUser. Bookings webhook writes to the same
 * table from a different path (api/webhook.js) — that one is
 * shared-secret-gated by Cal.com.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Client } from '@/app/admin/types';

// We never want this cached. The admin dashboard expects every fetch
// to reflect the latest writes (a name PATCH should be immediately
// visible on the next page render).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Digits-only phone normaliser. Matches the convention the API
 * contract documents and the migration backfill applies to legacy
 * rows. Returning null for empty/garbage input lets the caller
 * decide whether to 400 (required) or just continue (optional).
 */
function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * Light email sanitiser: trims and lowercases. We don't validate
 * structure here because the webhook already accepts arbitrary
 * strings — the admin should be able to PATCH a typo without the
 * API rejecting on RFC 5322 nitpicks. The form does the
 * "looks-like-an-email" check client-side.
 */
function sanitiseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Trim a name field; null when empty. Avoids storing whitespace-only strings. */
function sanitiseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

// ─── GET ────────────────────────────────────────────────────────────────────
//
// Query by ?phone=… (normalised before lookup). 404 on miss — callers
// that want create-on-miss semantics POST instead. We deliberately
// don't fall back to email lookup here: the CRM's contract is
// "phone identifies a client". If the caller knows only the email,
// they should resolve it to a phone upstream.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const phoneParam = req.nextUrl.searchParams.get('phone');
  const phone = normalisePhone(phoneParam);
  if (!phone) {
    return NextResponse.json(
      {
        error: 'missing_phone',
        hint: 'pass ?phone=... (digits-only after normalisation)',
      },
      { status: 400 }
    );
  }

  try {
    const { rows } = await sql<ClientRow>`
      SELECT id, phone, first_name, last_name, email, created_at
      FROM clients
      WHERE phone = ${phone}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ client: rowToClient(rows[0]) });
  } catch (err) {
    console.error('[api/admin/clients] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

// ─── POST ───────────────────────────────────────────────────────────────────
//
// First-Touch Lock-in: insert keyed by normalised phone. On conflict,
// DO NOT overwrite the existing first_name / last_name / email — the
// admin's explicit PATCH is the only path that should change those
// values. We use the "DO UPDATE SET phone = clients.phone" trick so
// RETURNING yields the row whether we INSERTed or hit the conflict
// branch (a normal "DO NOTHING" would return zero rows on conflict).
//
// Why not just SELECT-then-INSERT?
//   * It's two round-trips.
//   * It has a race window: two admin tabs could both pass the SELECT
//     and then both INSERT, with one tripping the UNIQUE constraint
//     as an error rather than a graceful "already exists".
// ON CONFLICT … DO UPDATE returns one row atomically.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
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
  const phone = normalisePhone(payload.phone);
  if (!phone) {
    return NextResponse.json(
      { error: 'missing_phone', hint: 'phone is required and must contain digits' },
      { status: 400 }
    );
  }
  const firstName = sanitiseName(payload.first_name);
  const lastName = sanitiseName(payload.last_name);
  const email = sanitiseEmail(payload.email);

  // Branch on whether an email-keyed row already exists.
  //
  // Why this branch matters:
  //   Pre-CRM, the webhook created clients keyed by email alone. After
  //   the migration's backfill, some of those rows have a phone, but
  //   any that share a phone with another row (the same person
  //   booking under multiple emails) intentionally stayed phone=NULL
  //   to avoid tripping the UNIQUE constraint. When the admin opens
  //   that person's profile, we want to "claim" that legacy row by
  //   adopting its existing first/last name rather than minting a
  //   second row keyed by phone.
  //
  // The match is: phone is NULL AND email matches the supplied one.
  // If we find a candidate, we UPDATE its phone in place. Otherwise
  // we fall through to the regular insert-or-existing branch.
  //
  // We only run this branch when the caller supplied an email,
  // because phone IS NULL AND email IS NULL would match a soup of
  // partial rows we have no business merging into.
  try {
    if (email) {
      // Adopt step: only happens once per legacy row (the WHERE
      // clause requires phone IS NULL so subsequent calls no-op).
      // The NOT EXISTS guard ensures we never overwrite ourselves
      // out of an existing phone-keyed row with the same number.
      const { rows: adopted } = await sql<ClientRow>`
        UPDATE clients c
        SET phone = ${phone}
        WHERE c.phone IS NULL
          AND c.email IS NOT NULL
          AND LOWER(TRIM(c.email)) = LOWER(TRIM(${email}))
          AND NOT EXISTS (
            SELECT 1 FROM clients c2 WHERE c2.phone = ${phone}
          )
        RETURNING id, phone, first_name, last_name, email, created_at
      `;
      if (adopted.length > 0) {
        console.log('[api/admin/clients] POST: adopted legacy email-keyed row', {
          id: adopted[0].id,
        });
        return NextResponse.json({
          client: rowToClient(adopted[0]),
          adopted: true,
        });
      }
    }

    const { rows } = await sql<ClientRow>`
      INSERT INTO clients (phone, first_name, last_name, email)
      VALUES (${phone}, ${firstName}, ${lastName}, ${email})
      ON CONFLICT (phone) DO UPDATE
        SET phone = clients.phone
      RETURNING id, phone, first_name, last_name, email, created_at
    `;
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'upsert_returned_no_row' },
        { status: 500 }
      );
    }
    return NextResponse.json({ client: rowToClient(rows[0]) });
  } catch (err) {
    // The most likely error here is a UNIQUE violation on
    // `clients_email_key` — somebody booked under this email before
    // (with no phone yet) and the adopt-step couldn't run because
    // the supplied email differs from what's on file. Fall back to a
    // pure phone-keyed insert with email=NULL so the CRM can still
    // proceed; the admin can fix the email mismatch from the edit form.
    const msg = errorMessage(err);
    const looksLikeEmailCollision =
      msg.includes('clients_email_key') ||
      msg.toLowerCase().includes('duplicate key') && msg.includes('email');
    if (looksLikeEmailCollision) {
      console.warn(
        '[api/admin/clients] POST: email collision, retrying without email',
        { phone, msg }
      );
      try {
        const { rows } = await sql<ClientRow>`
          INSERT INTO clients (phone, first_name, last_name, email)
          VALUES (${phone}, ${firstName}, ${lastName}, NULL)
          ON CONFLICT (phone) DO UPDATE
            SET phone = clients.phone
          RETURNING id, phone, first_name, last_name, email, created_at
        `;
        return NextResponse.json({
          client: rowToClient(rows[0]),
          email_collision: true,
        });
      } catch (retryErr) {
        console.error(
          '[api/admin/clients] POST retry without email also failed:',
          errorMessage(retryErr)
        );
        return NextResponse.json(
          { error: 'db_insert_failed', message: errorMessage(retryErr) },
          { status: 500 }
        );
      }
    }

    console.error('[api/admin/clients] POST failed:', msg);
    return NextResponse.json(
      { error: 'db_insert_failed', message: msg },
      { status: 500 }
    );
  }
}
