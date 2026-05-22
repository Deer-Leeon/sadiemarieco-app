'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageIcon, Upload } from 'lucide-react';

interface Props {
  /** Stable key into `site_images.id` — also drives the blob pathname. */
  imageId: string;
  /** Current public URL, or null if nothing's been uploaded yet. */
  currentUrl: string | null;
  /** Editorial label shown above the preview. */
  label: string;
}

/**
 * Self-contained upload tile.
 *
 * Wire contract:
 *   - Posts multipart `FormData` to /api/upload with two fields:
 *       * `file` (Blob)  — the chosen image
 *       * `id`   (string) — the imageId prop (the route's primary key)
 *   - On success, calls router.refresh() so the parent server component
 *     re-fetches `site_images` and the new URL flows back into this
 *     component via the `currentUrl` prop. No client-side state for the
 *     URL itself — the server is the single source of truth, which keeps
 *     us out of "stale React state vs. fresh DB" bugs.
 *
 * Error handling:
 *   - Network failures and 4xx/5xx responses both surface a short error
 *     message under the button. We DO NOT clear the file input on error
 *     so the user can retry without re-picking the file.
 */
export default function ImageUploader({
  imageId,
  currentUrl,
  label,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const triggerPicker = () => {
    if (isUploading) return;
    inputRef.current?.click();
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setIsUploading(true);

    const form = new FormData();
    form.append('file', file);
    form.append('id', imageId);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });

      if (!res.ok) {
        // Try to surface the server's error key — fall back to status
        // text if the body isn't JSON (e.g. platform-level 413).
        let detail = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* non-JSON body — keep statusText */
        }
        throw new Error(detail || 'upload_failed');
      }

      // Tell Next.js to re-run the parent server component. The fresh
      // image_url comes back through `currentUrl` automatically.
      router.refresh();
    } catch (err) {
      console.error('[ImageUploader] upload failed:', err);
      setErrorMsg(
        err instanceof Error
          ? humaniseUploadError(err.message)
          : 'Upload failed. Please try again.'
      );
    } finally {
      setIsUploading(false);
      // Reset the input so picking the same file twice still fires
      // `onChange` (browsers no-op when value === previous).
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </h3>

      {/* ── Preview / placeholder ────────────────────────────────────── */}
      {currentUrl ? (
        // Using a plain <img> rather than next/image because:
        //  1. Blob URLs aren't on the static `next.config` images domain
        //     allowlist by default,
        //  2. The admin tooling doesn't need next/image's optimisation
        //     pipeline — image quality matters on the public site, not
        //     in the editor preview.
        //
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={label}
          className="aspect-video w-full rounded-md bg-stone-100 object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md bg-stone-100">
          <ImageIcon className="h-8 w-8 text-stone-300" aria-hidden="true" />
        </div>
      )}

      {/* ── Hidden native file input ─────────────────────────────────── */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* ── Trigger button ───────────────────────────────────────────── */}
      <button
        type="button"
        onClick={triggerPicker}
        disabled={isUploading}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-stone-900 px-4 py-2 text-sm text-stone-50 transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-400"
      >
        {isUploading ? (
          'Uploading...'
        ) : (
          <>
            <Upload className="h-3.5 w-3.5" />
            {currentUrl ? 'Replace Image' : 'Upload Image'}
          </>
        )}
      </button>

      {errorMsg && (
        <p className="mt-2 text-xs text-rose-700" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

/**
 * Map server error keys to user-friendly copy. Anything we don't have a
 * mapping for falls through to the original detail string so we never
 * swallow useful diagnostic info.
 */
function humaniseUploadError(detail: string): string {
  switch (detail) {
    case 'file_too_large':
      return 'That image is over the 4.5 MB limit. Try compressing it first.';
    case 'unsupported_type':
      return 'Only JPG, PNG, WebP, AVIF, and GIF images are supported.';
    case 'empty_file':
      return 'That file is empty. Please pick a different image.';
    case 'invalid_id':
      return 'Internal error: image slot is misconfigured.';
    case 'unauthenticated':
    case 'forbidden':
      return 'You are not authorised to upload images.';
    case 'blob_upload_failed':
      return 'Could not reach storage. Please try again in a moment.';
    case 'db_upsert_failed':
      return 'Upload saved but the website record did not update. Please try again.';
    default:
      return `Upload failed (${detail}).`;
  }
}
