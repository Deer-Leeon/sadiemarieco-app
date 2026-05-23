/**
 * /api/admin/clients/[id]/photos
 *
 * Photo gallery storage for a single client. Each photo is a
 * `client_photos` row + a corresponding @vercel/blob object. The
 * BLOB itself is public-read (matches the existing site-image
 * pipeline in /api/upload) so the admin <img> tags work without
 * signed URLs. ClientProfileModal renders the gallery directly off
 * blob.url, so that public-read is load-bearing.
 *
 * Methods:
 *   GET   List all photos for the client, newest first. Used by
 *         ClientProfileModal to populate the pictures view.
 *
 *   POST  multipart/form-data with a single `file` field. Uploads
 *         the file to Vercel Blob and inserts the resulting URL
 *         into client_photos. Returns the new row so the UI can
 *         append it without a re-fetch.
 *
 * NOTE on image processing: this route does NOT apply the sRGB
 * normalisation that /api/upload does for site images. Client
 * photos are inspection / reference shots (before-after lash
 * shots, dye colour records, etc.) — they're shown only to the
 * admin and don't need consistent cross-browser colour. Skipping
 * the sharp pipeline keeps this route a thin pass-through.
 */
import { NextRequest, NextResponse } from 'next/server';
import { del, put } from '@vercel/blob';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { ClientPhoto } from '@/app/admin/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Same ceiling as /api/upload — Vercel serverless functions cap the
// non-streaming request body at ~4.5MB. Surface the constant so we
// can raise it in one place if we ever switch to client-driven
// uploads.
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;

const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PhotoRow {
  id: number;
  blob_url: string;
  uploaded_at: string;
}

function rowToPhoto(row: PhotoRow): ClientPhoto {
  return {
    id: row.id,
    blob_url: row.blob_url,
    uploaded_at: row.uploaded_at,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Strip everything but ASCII letters/digits/dot/dash/underscore so
 * the filename survives URL composition. Falls back to `photo` for
 * filenames that are entirely non-ASCII (e.g. emoji-only). Mirrors
 * the helper in /api/upload — duplicating the small helper rather
 * than exporting keeps the upload pipeline independently editable.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'photo';
}

interface Context {
  params: Promise<{ id: string }>;
}

// Verify the client exists before doing storage I/O. Cheap, and
// gives a clearer error than "FK violation" for the common
// "stale modal URL" failure mode.
async function assertClientExists(id: string): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS(SELECT 1 FROM clients WHERE id = ${id}::uuid) AS exists
  `;
  return rows[0]?.exists === true;
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
    const { rows } = await sql<PhotoRow>`
      SELECT id, blob_url, uploaded_at
      FROM client_photos
      WHERE client_id = ${id}::uuid
      ORDER BY uploaded_at DESC, id DESC
    `;
    return NextResponse.json({ photos: rows.map(rowToPhoto) });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] GET failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'db_select_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

// ─── POST ───────────────────────────────────────────────────────────────────
export async function POST(
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

  // Existence pre-check. Catches stale modals and dangling URLs
  // before we waste an upload. The FK on client_photos would catch
  // the bad state too, but only AFTER we've already burned the
  // blob put — which then needs a best-effort cleanup. Cheaper to
  // bail here.
  try {
    if (!(await assertClientExists(id))) {
      return NextResponse.json(
        { error: 'client_not_found' },
        { status: 404 }
      );
    }
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] existence check failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'db_check_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] formData parse failed:',
      errorMessage(err)
    );
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'empty_file' }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: 'file_too_large', maxBytes: MAX_FILE_BYTES },
      { status: 413 }
    );
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: 'unsupported_type', received: file.type || 'unknown' },
      { status: 415 }
    );
  }

  // Pathname includes the client id so the blob dashboard is
  // browsable by which client a photo belongs to. addRandomSuffix
  // (default true) avoids overwrite collisions when two photos
  // share a filename.
  const basename = sanitiseFilename(file.name);
  const pathname = `client-photos/${id}/${basename}`;

  let blob;
  try {
    blob = await put(pathname, file, {
      access: 'public',
      contentType: file.type,
    });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] blob put failed:',
      errorMessage(err)
    );
    return NextResponse.json({ error: 'blob_upload_failed' }, { status: 502 });
  }

  // DB insert. On failure, best-effort delete the blob so we don't
  // leak storage. Same pattern as /api/upload — failure to clean
  // up is logged but not fatal.
  try {
    const { rows } = await sql<PhotoRow>`
      INSERT INTO client_photos (client_id, blob_url)
      VALUES (${id}::uuid, ${blob.url})
      RETURNING id, blob_url, uploaded_at
    `;
    if (rows.length === 0) {
      throw new Error('insert returned no row');
    }
    console.log('[api/admin/clients/[id]/photos] photo uploaded', {
      clientId: id,
      photoId: rows[0].id,
      bytes: file.size,
    });
    return NextResponse.json({ photo: rowToPhoto(rows[0]) });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] db insert failed — attempting blob cleanup:',
      { clientId: id, blobUrl: blob.url, error: errorMessage(err) }
    );
    try {
      await del(blob.url);
    } catch (cleanupErr) {
      console.error(
        '[api/admin/clients/[id]/photos] orphan blob cleanup failed:',
        { blobUrl: blob.url, error: errorMessage(cleanupErr) }
      );
    }
    return NextResponse.json(
      { error: 'db_insert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
