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
import { PORTRAIT_SUBJECT, sanitisePhotoFileName } from '@/lib/photo-meta';
import { refreshPublicCatalog } from '@/lib/public-catalog-cache';

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
  alt_text: string | null;
  file_name: string | null;
  photo_subject: string | null;
}

export interface SiteImageSlotWire {
  id: string;
  image_url: string | null;
  caption: string | null;
  alt_text: string | null;
  file_name: string | null;
  photo_subject: string | null;
}

const SUBJECT_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

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

function parseStoredText(
  present: boolean,
  value: unknown,
  max: number,
  key: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!present) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `invalid_${key}` };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false, error: `${key}_too_long` };
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function parseFileName(
  present: boolean,
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!present) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'invalid_fileName' };
  if (value.trim().length > 120) return { ok: false, error: 'fileName_too_long' };
  const cleaned = sanitisePhotoFileName(value);
  return { ok: true, value: cleaned.length > 0 ? cleaned : null };
}

function parseSubject(
  present: boolean,
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!present) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'invalid_photo_subject' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed !== PORTRAIT_SUBJECT && !SUBJECT_REGEX.test(trimmed)) {
    return { ok: false, error: 'invalid_photo_subject' };
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
      SELECT id, image_url, caption, alt_text, file_name, photo_subject
      FROM site_images
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
        alt_text: row?.alt_text ?? null,
        file_name: row?.file_name ?? null,
        photo_subject: row?.photo_subject ?? null,
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

  const record = body as Record<string, unknown>;
  const { id } = record;
  if (typeof id !== 'string' || !isKnownSlotId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const hasCaption = 'caption' in record;
  const hasAlt = 'altText' in record;
  const hasFileName = 'fileName' in record;
  const hasSubject = 'photoSubject' in record;
  if (!hasCaption && !hasAlt && !hasFileName && !hasSubject) {
    return NextResponse.json({ error: 'missing_caption' }, { status: 400 });
  }

  let captionValue: string | null = null;
  if (hasCaption) {
    const parsed = normaliseCaptionInput(record.caption);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, maxChars: MAX_CAPTION_LENGTH },
        { status: 400 }
      );
    }
    captionValue = parsed.value;
  }

  const alt = parseStoredText(hasAlt, record.altText, MAX_CAPTION_LENGTH, 'altText');
  if (!alt.ok) {
    return NextResponse.json({ error: alt.error }, { status: 400 });
  }
  const fileName = parseFileName(hasFileName, record.fileName);
  if (!fileName.ok) {
    return NextResponse.json({ error: fileName.error }, { status: 400 });
  }
  const subject = parseSubject(hasSubject, record.photoSubject);
  if (!subject.ok) {
    return NextResponse.json({ error: subject.error }, { status: 400 });
  }

  try {
    const { rows } = await sql<SiteImageRow>`
      UPDATE site_images
      SET
        caption = CASE
          WHEN ${hasCaption}::boolean THEN ${captionValue}
          ELSE caption
        END,
        alt_text = CASE
          WHEN ${hasAlt}::boolean THEN ${alt.value}
          ELSE alt_text
        END,
        file_name = CASE
          WHEN ${hasFileName}::boolean THEN ${fileName.value}
          ELSE file_name
        END,
        photo_subject = CASE
          WHEN ${hasSubject}::boolean THEN ${subject.value}
          ELSE photo_subject
        END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, image_url, caption, alt_text, file_name, photo_subject
    `;

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'slot_not_found', hint: 'Upload an image for this slot first.' },
        { status: 404 }
      );
    }

    refreshPublicCatalog();
    const row = rows[0];
    return NextResponse.json({
      slot: {
        id: row.id,
        image_url: row.image_url,
        caption: row.caption,
        alt_text: row.alt_text,
        file_name: row.file_name,
        photo_subject: row.photo_subject,
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
