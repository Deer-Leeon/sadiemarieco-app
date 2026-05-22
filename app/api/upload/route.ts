/**
 * POST /api/upload
 *
 * Admin-only image upload pipeline:
 *   1. Authenticate via Clerk + admin email allowlist (defence-in-depth;
 *      proxy.ts wires up Clerk context for /api/* but does not gate
 *      individual routes).
 *   2. Parse multipart FormData → { file, id }.
 *   3. Normalise the image to sRGB (see comment on `normaliseToSrgb`).
 *      This is the SAME transformation that scripts/convert_to_srgb.py
 *      applies to the bundled assets — applied automatically on every
 *      upload so iPhone Display P3 photos don't render over-exposed in
 *      Chrome / Firefox / Edge.
 *   4. Persist the processed bytes to Vercel Blob with public read access.
 *   5. UPSERT the resulting public URL into `site_images` keyed by `id`.
 *   6. Return the new URL so the client can optimistically re-render
 *      (or call router.refresh() to re-fetch the server view).
 *
 * Why this route exists at all (vs. direct browser-to-Blob uploads):
 *   - We want a single trusted choke-point for "who is allowed to mutate
 *     site images" + audit logging. Direct browser uploads would require
 *     issuing scoped client tokens, which is more moving parts than this
 *     studio needs today.
 *   - We want server-side image processing (sRGB conversion). Browser-
 *     side processing would require shipping libvips/sharp to the client
 *     (huge) or implementing color-space conversion in pure JS (slow).
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
import sharp from 'sharp';

import { requireAdminUser } from '@/app/admin/auth';

// Default request body cap for App Router route handlers is generous, but
// Vercel's serverless platform itself enforces a 4.5MB body limit on
// regular (non-streaming) function invocations. For larger uploads we'd
// need to switch to client-driven uploads (`upload()` from @vercel/blob).
// Typical studio photography (compressed JPEG/WebP) is comfortably under
// this ceiling; we surface the constraint as a constant so future raises
// only require changing one place.
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;

// Safety cap so a maliciously crafted huge-dimension image can't OOM the
// serverless function during sharp decode. 268 megapixels is ~26× a 41MP
// iPhone Pro photo and ~50× a typical DSLR — anything beyond it is almost
// certainly an attack or a bug.
const SHARP_PIXEL_LIMIT = 2 ** 28;

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

interface ProcessedImage {
  buffer: Buffer;
  mime: string;
  extension: string;
}

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

  // ── SRGB NORMALISATION ─────────────────────────────────────────────────
  // The load-bearing step for fixing iPhone Display P3 over-exposure. See
  // `normaliseToSrgb` below for the full reasoning.
  let processed: ProcessedImage;
  try {
    processed = await normaliseToSrgb(file);
  } catch (err) {
    console.error('[api/upload] sharp processing failed:', {
      id,
      size: file.size,
      type: file.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'image_processing_failed' },
      { status: 422 }
    );
  }

  // ── BLOB UPLOAD ────────────────────────────────────────────────────────
  // Pathname includes the logical id so the blob dashboard is browsable
  // by site-image slug rather than a flat list of opaque hashes. We use
  // the post-processing extension (not the upload's original extension)
  // so the CDN serves the right Content-Type — e.g. a HEIC upload that
  // got transcoded to JPEG will be stored as `…/foo.jpg`, not `…/foo.heic`.
  //
  // `addRandomSuffix: true` (default) ensures each upload yields a unique
  // URL — important because cached <img src> on the live site would
  // otherwise keep serving the old image until the CDN evicted it. The
  // Postgres row gets the new URL on upsert, so the next page render
  // surfaces the fresh image immediately.
  const basename = stripExtension(sanitiseFilename(file.name)) || 'image';
  const pathname = `site-images/${id}/${basename}.${processed.extension}`;

  let blob;
  try {
    blob = await put(pathname, processed.buffer, {
      access: 'public',
      contentType: processed.mime,
    });
  } catch (err) {
    console.error('[api/upload] blob put failed:', {
      id,
      bytes: processed.buffer.length,
      type: processed.mime,
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
    inputBytes: file.size,
    inputType: file.type,
    outputBytes: processed.buffer.length,
    outputType: processed.mime,
  });

  return NextResponse.json({ url: blob.url, id });
}

/**
 * Convert any uploaded image to sRGB and re-encode through a known-good
 * encoder. Mirrors the behaviour of scripts/convert_to_srgb.py so that
 * images coming through the CMS look identical to the ones we processed
 * offline back when we built the site.
 *
 * Why this matters:
 *   iPhone photos ship with a Display P3 ICC profile embedded. Safari
 *   colour-manages that profile correctly and renders accurate colours.
 *   Chrome, Firefox and Edge all handle P3 inconsistently — typically
 *   over-saturated / over-exposed, which makes faces look sunburnt and
 *   white backgrounds look pink. The studio uploads these photos
 *   directly from an iPhone, so without intervention every Chrome user
 *   sees the wrong colours on the live site.
 *
 *   The fix: read the embedded ICC profile, transform the pixel data
 *   into the sRGB working space using a perceptual rendering intent,
 *   then attach an sRGB ICC profile to the output. `.withIccProfile()`
 *   in sharp does all three steps in one call (libvips under the hood).
 *
 * Other things this function does that the original Python script does:
 *   - .rotate() with no args reads EXIF Orientation and bakes the
 *     rotation into pixels. Some browsers (or downstream tools) ignore
 *     the Orientation tag, so baking it in once removes a class of bugs.
 *   - High-quality JPEG settings (q=90, 4:4:4 chroma, progressive,
 *     mozjpeg encoder) that match scripts/convert_to_srgb.py exactly.
 *   - .keepExif() preserves the rest of the EXIF block (camera info,
 *     timestamps). The Python script does the same. NOTE: this also
 *     preserves GPS coordinates if present — phones strip these by
 *     default for shared photos but not always. If that ever becomes a
 *     privacy concern we can swap this for .keepIccProfileOnly() or
 *     equivalent (drops everything except the new sRGB profile).
 *
 * Output format strategy:
 *   - JPEG, AVIF, GIF inputs → re-encoded as JPEG. (AVIF and GIF on a
 *     marketing site is unusual; converting to JPEG yields predictable
 *     downstream behaviour. Animated GIFs lose animation — acceptable
 *     for our use case where uploads are studio photography, not memes.)
 *   - PNG inputs → preserved as PNG so transparency survives.
 *   - WebP inputs → preserved as WebP for the same reason.
 */
async function normaliseToSrgb(file: File): Promise<ProcessedImage> {
  const input = Buffer.from(await file.arrayBuffer());

  const base = sharp(input, {
    // Tolerate slightly malformed images (some phones produce JPEGs with
    // trailing garbage). 'truncated' is the strictest setting we can use
    // while still accepting these — anything stricter rejects perfectly
    // valid phone uploads.
    failOn: 'truncated',
    limitInputPixels: SHARP_PIXEL_LIMIT,
  })
    .rotate()
    .withIccProfile('srgb');

  if (file.type === 'image/png') {
    return {
      buffer: await base.png({ compressionLevel: 9 }).keepExif().toBuffer(),
      mime: 'image/png',
      extension: 'png',
    };
  }

  if (file.type === 'image/webp') {
    return {
      buffer: await base.webp({ quality: 90 }).keepExif().toBuffer(),
      mime: 'image/webp',
      extension: 'webp',
    };
  }

  // image/jpeg, image/avif, image/gif → JPEG (the conservative default).
  return {
    buffer: await base
      .jpeg({
        quality: 90,
        chromaSubsampling: '4:4:4',
        progressive: true,
        mozjpeg: true,
      })
      .keepExif()
      .toBuffer(),
    mime: 'image/jpeg',
    extension: 'jpg',
  };
}

/** Strip the final `.ext` from a filename. Returns the input unchanged if
 *  there's no extension or the filename starts with a dot (`.hidden`). */
function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? name : name.slice(0, idx);
}

/**
 * Strip everything but ASCII letters/digits/dot/dash/underscore from a
 * filename so it survives URL composition. Falls back to `image` for
 * filenames that are entirely non-ASCII (e.g. cyrillic upload from
 * mobile). Extension is preserved if present, but `stripExtension` above
 * is responsible for removing it before the post-processing extension
 * gets appended.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'image';
}
