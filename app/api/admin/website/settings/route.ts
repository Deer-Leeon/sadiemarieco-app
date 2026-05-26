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
 * Mutations stay on `POST /api/upload` (multipart image + optional caption).
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Slots rendered by `/admin/website`. Keep in sync with
 * `app/admin/website/page.tsx` KNOWN_SLOT_IDS.
 */
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
