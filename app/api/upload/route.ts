/**
 * POST /api/upload
 *
 * Admin-only image upload pipeline:
 *   1. Authenticate via Clerk + admin email allowlist (defence-in-depth;
 *      middleware doesn't gate /api/** by default).
 *   2. Parse multipart FormData → { file, id }.
 *   3. Persist the file to Vercel Blob with public read access.
 *   4. UPSERT the resulting public URL into `site_images` keyed by `id`.
 *   5. Return the new URL so the client can optimistically re-render
 *      (or call router.refresh() to re-fetch the server view).
 *
 * Why this route exists at all (vs. direct browser-to-Blob uploads):
 *   - We want a single trusted choke-point for "who is allowed to mutate
 *     site images" + audit logging. Direct browser uploads would require
 *     issuing scoped client tokens, which is more moving parts than this
 *     studio needs today.
 *   - We want to write the Postgres row in the same transaction as the
 *     blob put. A failed DB write here triggers a best-effort blob cleanup
 *     (orphan blobs cost money and clutter the dashboard).
 *
 * Required environment variables:
 *   - BLOB_READ_WRITE_TOKEN  (auto-injected by Vercel; .env.local locally)
 *   - POSTGRES_URL           (read by @vercel/postgres automatically)
 *   - CLERK_SECRET_KEY       (used by @clerk/nextjs/server.auth/currentUser)
 */
import { NextRequest, NextResponse } from 'next/server';
import { del, put } from '@vercel/blob';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';

// Default request body cap for App Router route handlers is generous, but
// Vercel's serverless platform itself enforces a 4.5MB body limit on
// regular (non-streaming) function invocations. For larger uploads we'd
// need to switch to client-driven uploads (`upload()` from @vercel/blob).
// Typical studio photography (compressed JPEG/WebP) is comfortably under
// this ceiling; we surface the constraint as a constant so future raises
// only require changing one place.
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;

// Whitelist of accepted image MIME types. We deliberately accept the
// modern set rather than `image/*` so a misconfigured client can't sneak
// a non-renderable payload (e.g. SVG with embedded JS) onto our CDN.
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

// Conservative slug for the id, used both as the Postgres primary key and
// as part of the blob pathname. Anything that doesn't survive this regex
// risks generating malformed URLs or schema collisions.
const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  // ── PARSE INPUT ────────────────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error('[api/upload] formData parse failed:', err);
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const file = form.get('file');
  const id = form.get('id');

  if (typeof id !== 'string' || !ID_REGEX.test(id)) {
    return NextResponse.json(
      { error: 'invalid_id', hint: 'id must be 1-64 chars of [a-zA-Z0-9_-]' },
      { status: 400 }
    );
  }
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

  // ── BLOB UPLOAD ────────────────────────────────────────────────────────
  // Pathname includes the logical id so the blob dashboard is browsable
  // by site-image slug rather than a flat list of opaque hashes. The
  // file's original extension is preserved so the CDN serves the right
  // Content-Type even if we ever change MIME detection logic.
  //
  // `addRandomSuffix: true` (default) ensures each upload yields a unique
  // URL — important because cached <img src> on the live site would
  // otherwise keep serving the old image until the CDN evicted it. The
  // Postgres row gets the new URL on upsert, so the next page render
  // surfaces the fresh image immediately.
  const pathname = `site-images/${id}/${sanitiseFilename(file.name)}`;

  let blob;
  try {
    blob = await put(pathname, file, {
      access: 'public',
      contentType: file.type,
    });
  } catch (err) {
    console.error('[api/upload] blob put failed:', {
      id,
      size: file.size,
      type: file.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'blob_upload_failed' }, { status: 502 });
  }

  // ── DB UPSERT ──────────────────────────────────────────────────────────
  // If this fails the blob is orphaned. We best-effort delete it so we
  // don't leak storage — failure of the cleanup is logged but not fatal.
  try {
    await sql`
      INSERT INTO site_images (id, image_url)
      VALUES (${id}, ${blob.url})
      ON CONFLICT (id) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        updated_at = NOW()
    `;
  } catch (err) {
    console.error('[api/upload] db upsert failed — attempting blob cleanup:', {
      id,
      blobUrl: blob.url,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await del(blob.url);
    } catch (cleanupErr) {
      console.error('[api/upload] orphan blob cleanup also failed:', {
        blobUrl: blob.url,
        error:
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    return NextResponse.json({ error: 'db_upsert_failed' }, { status: 500 });
  }

  console.log('[api/upload] image upserted', {
    id,
    bytes: file.size,
    type: file.type,
  });

  return NextResponse.json({ url: blob.url, id });
}

/**
 * Strip everything but ASCII letters/digits/dot/dash/underscore from a
 * filename so it survives URL composition. Falls back to `image` for
 * filenames that are entirely non-ASCII (e.g. cyrillic upload from
 * mobile). Extension is preserved if present.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'image';
}
