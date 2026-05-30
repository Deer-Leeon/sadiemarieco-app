/**
 * GET /api/admin/settings/template
 * POST /api/admin/settings/template
 *
 * Global consent PDF template stored in Vercel Blob; URL persisted on
 * the singleton `studio_settings` row (id = 1).
 *
 * POST: multipart/form-data with a single `file` field (application/pdf).
 */
import { NextRequest, NextResponse } from 'next/server';
import { del, put } from '@vercel/blob';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  STUDIO_SETTINGS_ROW_ID,
  type ConsentTemplateWire,
  type StudioSettings,
} from '@/lib/studio-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Matches Vercel serverless request body limit for non-streaming uploads. */
const MAX_PDF_BYTES = 4.5 * 1024 * 1024;

interface SettingsRow {
  id: number;
  consent_pdf_url: string | null;
  updated_at: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'consent-template';
}

function isPdfFile(file: File): boolean {
  const mime = (file.type || '').toLowerCase();
  if (mime === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name);
}

function rowToWire(row: SettingsRow): ConsentTemplateWire {
  return { consent_pdf_url: row.consent_pdf_url };
}

async function fetchSettingsRow(): Promise<SettingsRow | null> {
  const { rows } = await sql<SettingsRow>`
    SELECT id, consent_pdf_url, updated_at
    FROM studio_settings
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
  `;
  return rows[0] ?? null;
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
    const row = await fetchSettingsRow();
    if (!row) {
      return NextResponse.json(
        {
          error: 'settings_row_missing',
          hint: 'Run scripts/create_studio_settings.sql',
        },
        { status: 500 }
      );
    }
    return NextResponse.json(rowToWire(row));
  } catch (err) {
    console.error('[api/admin/settings/template] GET failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }

  if (!isPdfFile(file)) {
    return NextResponse.json(
      { error: 'invalid_file_type', allowed: ['application/pdf', '.pdf'] },
      { status: 400 }
    );
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: 'empty_file' }, { status: 400 });
  }

  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      {
        error: 'file_too_large',
        maxBytes: MAX_PDF_BYTES,
        maxMb: 4.5,
      },
      { status: 413 }
    );
  }

  let previousUrl: string | null = null;
  try {
    const existing = await fetchSettingsRow();
    if (!existing) {
      return NextResponse.json(
        {
          error: 'settings_row_missing',
          hint: 'Run scripts/create_studio_settings.sql',
        },
        { status: 500 }
      );
    }
    previousUrl = existing.consent_pdf_url;
  } catch (err) {
    console.error(
      '[api/admin/settings/template] pre-upload fetch failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  const safeName = sanitiseFilename(file.name);
  const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const pathname = `studio-settings/consent-template/${uniqueName}`;

  const buffer = Buffer.from(await file.arrayBuffer());

  let blob;
  try {
    blob = await put(pathname, buffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: true,
    });
  } catch (err) {
    console.error('[api/admin/settings/template] blob put failed:', errorMessage(err));
    return NextResponse.json({ error: 'blob_upload_failed' }, { status: 502 });
  }

  let updated: SettingsRow;
  try {
    const { rows } = await sql<SettingsRow>`
      UPDATE studio_settings
      SET consent_pdf_url = ${blob.url}, updated_at = NOW()
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
      RETURNING id, consent_pdf_url, updated_at
    `;
    if (rows.length === 0) {
      throw new Error('update returned no row');
    }
    updated = rows[0];
  } catch (err) {
    console.error(
      '[api/admin/settings/template] db update failed — deleting new blob:',
      { blobUrl: blob.url, error: errorMessage(err) }
    );
    try {
      await del(blob.url);
    } catch (cleanupErr) {
      console.error(
        '[api/admin/settings/template] orphan blob cleanup failed:',
        errorMessage(cleanupErr)
      );
    }
    return NextResponse.json(
      { error: 'db_update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  if (previousUrl && previousUrl !== blob.url) {
    try {
      await del(previousUrl);
    } catch (err) {
      console.warn(
        '[api/admin/settings/template] old template blob delete failed (orphan):',
        { previousUrl, error: errorMessage(err) }
      );
    }
  }

  const payload: ConsentTemplateWire & Pick<StudioSettings, 'updated_at'> = {
    consent_pdf_url: updated.consent_pdf_url,
    updated_at: updated.updated_at,
  };

  return NextResponse.json(payload);
}
