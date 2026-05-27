/**
 * GET /api/admin/website/settings
 *
 * Site image CMS payload for the native iOS admin app (and any other API
 * consumer). Returns the same slot data the web editor loads in
 * `app/admin/website/page.tsx`.
 *
 * Response (200):
 *   {
 *     "slots": [
 *       { "id": "home_hero", "image_url": "https://…", "caption": null },
 *       …
 *     ]
 *   }
 *
 * Every {@link KNOWN_SLOT_IDS} entry is always present in `slots`, in
 * catalogue order. Missing DB rows surface as `image_url: null` and
 * `caption: null` so the client can render empty upload targets without
 * hard-coding the slot list.
 *
 * Orphan `site_images` rows (legacy slot ids) are dropped — same filter
 * as the server component.
 *
 * Auth: `requireAdminUser()` — Clerk session (cookie or Bearer JWT) plus
 * the email allowlist in `app/admin/auth.ts`.
 *
 * Mutations:
 *   • `POST /api/upload` — multipart image + optional caption.
 *   • `PATCH` (this route) — caption-only updates for an existing slot.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Slots rendered by `/admin/website`. Keep in sync with
 * `app/admin/website/page.tsx` KNOWN_SLOT_IDS.
 */
const MAX_CAPTION_LENGTH = 300;

const KNOWN_SLOT_IDS = [
  'home_hero',
  'about_profile',
  'portfolio_1',
  'portfolio_2',
  'portfolio_3',
  'portfolio_4',
  'portfolio_5',
] as const;

interface SiteImageRow {
  id: string;
  image_url: string;
  caption: string | null;
}

export interface SiteImageSlotWire {
  id: string;
  image_url: string | null;
  caption: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isKnownSlotId(id: string): id is (typeof KNOWN_SLOT_IDS)[number] {
  return (KNOWN_SLOT_IDS as readonly string[]).includes(id);
}

/**
 * Normalise a caption from the wire:
 *   • non-empty string → trimmed custom caption
 *   • empty string     → stored as '' (hide overlay on the public site)
 *   • null             → stored as NULL (fall back to hardcoded HTML)
 */
function normaliseCaptionInput(
  caption: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (caption === null) {
    return { ok: true, value: null };
  }
  if (typeof caption !== 'string') {
    return { ok: false, error: 'invalid_caption' };
  }
  const trimmed = caption.trim();
  if (trimmed.length > MAX_CAPTION_LENGTH) {
    return { ok: false, error: 'caption_too_long' };
  }
  if (trimmed.length === 0) {
    return { ok: true, value: '' };
  }
  return { ok: true, value: trimmed };
}

export async function GET(): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  try {
    const { rows } = await sql<SiteImageRow>`
      SELECT id, image_url, caption FROM site_images
    `;

    const knownIds = new Set<string>(KNOWN_SLOT_IDS);
    const byId = new Map<string, SiteImageRow>();
    for (const row of rows) {
      if (knownIds.has(row.id)) {
        byId.set(row.id, row);
      }
    }

    const slots: SiteImageSlotWire[] = KNOWN_SLOT_IDS.map((id) => {
      const row = byId.get(id);
      return {
        id,
        image_url: row?.image_url ?? null,
        caption: row?.caption ?? null,
      };
    });

    return NextResponse.json({ slots });
  } catch (err) {
    console.error('[api/admin/website/settings] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/admin/website/settings
 *
 * Body: `{ "id": "portfolio_1", "caption": "Classic Lashes" }`
 *
 * Caption semantics (matches upload + public renderer):
 *   • non-empty string → custom overlay text
 *   • `""`             → hide overlay (stored as empty string)
 *   • `null`           → revert to hardcoded `.p-tag` in `public/index.html`
 *
 * Requires an existing `site_images` row (upload an image first).
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
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

  const { id, caption } = body as { id?: unknown; caption?: unknown };
  if (typeof id !== 'string' || !isKnownSlotId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  if (!('caption' in (body as object))) {
    return NextResponse.json({ error: 'missing_caption' }, { status: 400 });
  }

  const parsed = normaliseCaptionInput(caption);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, maxChars: MAX_CAPTION_LENGTH },
      { status: parsed.error === 'caption_too_long' ? 400 : 400 }
    );
  }

  try {
    const { rows } = await sql<SiteImageRow>`
      UPDATE site_images
      SET caption = ${parsed.value}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, image_url, caption
    `;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'slot_not_found', hint: 'Upload an image for this slot first.' },
        { status: 404 }
      );
    }

    const row = rows[0];
    return NextResponse.json({
      slot: {
        id: row.id,
        image_url: row.image_url,
        caption: row.caption,
      },
    });
  } catch (err) {
    console.error('[api/admin/website/settings] PATCH failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
