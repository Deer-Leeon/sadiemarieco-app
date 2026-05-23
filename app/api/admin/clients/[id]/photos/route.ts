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
import sharp from 'sharp';

import { requireAdminUser } from '@/app/admin/auth';
import type { ClientPhoto } from '@/app/admin/types';

// Sharp is a native module and incompatible with the Edge runtime —
// force-pin Node so HEIC conversion has access to libvips + libheif.
export const runtime = 'nodejs';
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

/**
 * HEIC detection. Mirrors the client-side heuristic: trust MIME
 * first, fall back to filename extension because some upload
 * pipelines drop the type field for HEIC.
 */
function isHeicFile(filename: string, mime: string): boolean {
  const m = mime.toLowerCase();
  if (m === 'image/heic' || m === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(filename);
}

/**
 * Server-side HEIC/HEIF → JPEG conversion. Three decoder paths
 * already failed by the time bytes reach us:
 *
 *   1. Chrome's native <img> decoder — rejects newer Apple HEIC
 *      variants (HDR, 10-bit, Live Photo sequences).
 *   2. heic2any (libheif WASM, 2020 build) — old libheif, no
 *      HEVC plugin → "ERR_LIBHEIF format not supported".
 *   3. sharp's libheif — modern, but its macOS/Linux prebuilt
 *      binaries OMIT the HEVC decoder plugin (libde265 / x265)
 *      due to redistribution licensing → "Support for this
 *      compression format has not been built in".
 *
 * So we try sharp first (fast when it works — non-HEVC HEICs,
 * or builds with the plugin), and fall back to `heic-convert`
 * which ships its own libheif-js WASM build with libde265
 * bundled. Output of the fallback gets piped back through sharp
 * for resize + mozjpeg encoding so both paths produce the same
 * shape of file.
 *
 * Returns a processed JPEG buffer + suggested filename. The
 * resize step caps output at 2048×2048 (matching what the
 * gallery actually renders) to keep stored blobs small.
 */
interface ProcessedImage {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

async function convertHeicToJpegServer(
  input: Buffer,
  originalFilename: string
): Promise<ProcessedImage> {
  let jpegBuffer: Buffer;

  try {
    // ── Path A: sharp direct ────────────────────────────────
    jpegBuffer = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch (sharpErr) {
    console.warn(
      '[api/admin/clients/[id]/photos] sharp HEIC decode failed — falling back to heic-convert',
      { name: originalFilename, error: errorMessage(sharpErr) }
    );

    // ── Path B: heic-convert (libheif-js w/ libde265 WASM) ──
    // Dynamic import so the module's WASM payload (~3 MB) only
    // loads when we actually need it. CommonJS interop yields
    // `{ default: heicConvert }` via esModuleInterop.
    const heicConvertModule = await import('heic-convert');
    const heicConvert = heicConvertModule.default;
    const intermediateAb = await heicConvert({
      buffer: input,
      format: 'JPEG',
      quality: 0.92,
    });

    // Pipe heic-convert's full-resolution JPEG back through
    // sharp to apply the same resize + mozjpeg encoder we use
    // on the fast path. Decoding a normal JPEG works fine with
    // any sharp build.
    jpegBuffer = await sharp(Buffer.from(intermediateAb))
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  }

  return {
    buffer: jpegBuffer,
    filename: originalFilename.replace(/\.(heic|heif)$/i, '.jpg'),
    contentType: 'image/jpeg',
  };
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
  if (!ALLOWED_MIME.has(file.type) && !isHeicFile(file.name, file.type)) {
    // Permit HEIC even when MIME is missing/wrong — we re-check
    // explicitly so HEIC uploads from clients that strip the type
    // field still get through to the sharp conversion below.
    return NextResponse.json(
      { error: 'unsupported_type', received: file.type || 'unknown' },
      { status: 415 }
    );
  }

  // ── HEIC → JPEG conversion (server-side via sharp) ──────────
  // Runs ONLY when the client either:
  //   * couldn't decode the HEIC itself (neither native nor
  //     heic2any worked — common for newer iPhone HDR variants), or
  //   * forwarded the raw HEIC bytes intentionally.
  // For everything else (JPEG, PNG, WebP, AVIF, GIF) we still
  // pass through unmodified — keeps non-HEIC uploads as a thin
  // proxy without unnecessary re-encoding.
  let processedBuffer: Buffer | null = null;
  let processedFilename: string = file.name;
  let processedContentType: string = file.type;

  if (isHeicFile(file.name, file.type)) {
    try {
      const inputBuffer = Buffer.from(await file.arrayBuffer());
      const result = await convertHeicToJpegServer(inputBuffer, file.name);
      processedBuffer = result.buffer;
      processedFilename = result.filename;
      processedContentType = result.contentType;
      console.log('[api/admin/clients/[id]/photos] HEIC → JPEG converted', {
        clientId: id,
        originalName: file.name,
        originalBytes: file.size,
        jpegBytes: processedBuffer.byteLength,
      });
    } catch (err) {
      console.error(
        '[api/admin/clients/[id]/photos] sharp HEIC conversion failed:',
        { name: file.name, error: errorMessage(err) }
      );
      return NextResponse.json(
        {
          error: 'heic_conversion_failed',
          message: errorMessage(err),
        },
        { status: 422 }
      );
    }
  }

  // Pathname includes the client id so the blob dashboard is
  // browsable by which client a photo belongs to.
  //
  // Filename uniqueness is enforced two ways, belt-and-suspenders:
  //
  //   1. We prepend `${Date.now()}-${random6}` to the (sanitised)
  //      filename. This makes the pathname unique by construction —
  //      even two simultaneous uploads of the SAME file from the
  //      SAME client get different keys, because Date.now() advances
  //      and Math.random() is independent per call. Without this,
  //      the studio hit a 502 blob_upload_failed whenever a photo
  //      was re-uploaded with an identical filename (which is common
  //      when phones use generic names like IMG_3784.png).
  //
  //   2. `addRandomSuffix: true` on the put() call. Recent versions
  //      of @vercel/blob flipped the default from `true` to `false`,
  //      so without this explicit flag, identical pathnames would
  //      collide instead of getting a suffix. Setting it true here
  //      gives us a second uniqueness layer even if (1) ever fails
  //      (e.g. clock skew making two Date.now() values equal in the
  //      same millisecond on the same random rng tick).
  //
  // The (possibly HEIC→JPG renamed) filename stays as the trailing
  // component so the Vercel Blob dashboard remains scanable — e.g.
  // "1716504123456-9k4b2j-IMG_3784.jpg".
  const safeOriginalName = sanitiseFilename(processedFilename);
  const uniqueFilename = `${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 8)}-${safeOriginalName}`;
  const pathname = `client-photos/${id}/${uniqueFilename}`;

  // Pass the converted JPEG buffer when we did sharp work, else
  // the original File. @vercel/blob.put() handles both shapes.
  const uploadBody: Buffer | File = processedBuffer ?? file;

  let blob;
  try {
    blob = await put(pathname, uploadBody, {
      access: 'public',
      contentType: processedContentType,
      addRandomSuffix: true,
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
      inputBytes: file.size,
      storedBytes: processedBuffer?.byteLength ?? file.size,
      converted: processedBuffer !== null,
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

// ─── DELETE ─────────────────────────────────────────────────────────────────
/**
 * Removes a single photo from BOTH the `client_photos` row and the
 * @vercel/blob object behind it.
 *
 * Body: `{ photoId: number, blobUrl: string }`.
 *   * `photoId` — the `client_photos.id` of the photo to remove.
 *   * `blobUrl` — accepted but treated as a hint. We use the DB's
 *     stored `blob_url` as the authoritative target for `del()`,
 *     so a malicious admin can't pass someone else's blob URL
 *     alongside their own photoId.
 *
 * Order of operations is `DELETE ... RETURNING blob_url` FIRST,
 * then a best-effort `del()` on the returned URL:
 *   * The DB delete is scoped by BOTH photo id AND client_id from
 *     the URL params, so a stale modal can't delete a row that's
 *     since been re-assigned to a different client.
 *   * If 0 rows come back we 404 without touching storage — the
 *     row was already gone or never belonged to this client.
 *   * If the blob `del()` fails the row is still gone; we log and
 *     return 200. Orphan blobs cost a few KB and are cheaper than
 *     re-running the entire delete just because storage flaked.
 */
interface DeleteBody {
  photoId?: unknown;
  blobUrl?: unknown;
}

export async function DELETE(
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

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] DELETE: invalid JSON body:',
      errorMessage(err)
    );
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const photoId = Number(body.photoId);
  if (!Number.isInteger(photoId) || photoId <= 0) {
    return NextResponse.json(
      { error: 'invalid_photo_id', received: body.photoId },
      { status: 400 }
    );
  }
  // blobUrl is accepted for forward-compatibility but not trusted
  // (see comment block above) — we use the DB's blob_url instead.
  if (body.blobUrl !== undefined && typeof body.blobUrl !== 'string') {
    return NextResponse.json(
      { error: 'invalid_blob_url' },
      { status: 400 }
    );
  }

  // Atomic delete, scoped by client_id. Returning blob_url gives
  // us the authoritative storage target without a second round-trip.
  let deletedBlobUrl: string;
  try {
    const { rows } = await sql<{ blob_url: string }>`
      DELETE FROM client_photos
      WHERE id = ${photoId} AND client_id = ${id}::uuid
      RETURNING blob_url
    `;
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'photo_not_found' },
        { status: 404 }
      );
    }
    deletedBlobUrl = rows[0].blob_url;
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/photos] DELETE: db delete failed:',
      { clientId: id, photoId, error: errorMessage(err) }
    );
    return NextResponse.json(
      { error: 'db_delete_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  // Best-effort blob cleanup. Failure here doesn't roll back the
  // DB delete — the row is already gone and re-inserting it would
  // re-orphan the storage we're trying to clean up anyway.
  let blobCleanupError: string | null = null;
  try {
    await del(deletedBlobUrl);
  } catch (err) {
    blobCleanupError = errorMessage(err);
    console.error(
      '[api/admin/clients/[id]/photos] DELETE: blob del failed (orphan storage):',
      { clientId: id, photoId, blobUrl: deletedBlobUrl, error: blobCleanupError }
    );
  }

  console.log('[api/admin/clients/[id]/photos] photo deleted', {
    clientId: id,
    photoId,
    blobUrl: deletedBlobUrl,
    blobCleanupError,
  });

  return NextResponse.json({
    ok: true,
    photoId,
    blobCleanupError,
  });
}
