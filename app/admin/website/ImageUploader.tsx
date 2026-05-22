'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageIcon, Pencil } from 'lucide-react';

interface Props {
  /** Stable key into `site_images.id` — also drives the blob pathname. */
  imageId: string;
  /** Current public URL, or null if nothing's been uploaded yet. */
  currentUrl: string | null;
  /** Editorial label shown above the preview (card) or on hover (tile). */
  label: string;
  /**
   * Tailwind aspect-ratio class applied to the preview frame so the
   * editor tile mirrors the shape of the slot on the live site (WYSIWYG).
   *
   * Pass as a literal so Tailwind's JIT can see it: `aspect-[4/5]`,
   * `aspect-[3/4]`, `aspect-[3/2]`. Defaults to `aspect-video`.
   *
   * Ignored in `tile` variant when the parent supplies a fixed grid-row
   * height — the image fills the cell via `h-full` and aspect ratio is
   * dictated by the grid cell.
   */
  aspectClass?: string;
  /**
   * Optional extra classes appended to the card root. Most common use:
   * `h-full` so the card fills its grid cell and siblings stay aligned
   * when one of them grows (e.g. an error message appears).
   */
  className?: string;
  /**
   * Visual style:
   *   - `'card'` (default) — white card chrome with the slot label
   *     printed above the image. Used for the Core Pages section so the
   *     editor sees context at a glance.
   *   - `'tile'` — edge-to-edge image with no card chrome, label hidden
   *     until hover. Mirrors the live site's `.p-item` style for the
   *     Portfolio Collage section.
   *
   * Both variants share the same click-to-replace interaction: clicking
   * the image opens the native file picker. There is intentionally no
   * separate "Replace Image" button — the image itself is the affordance.
   */
  variant?: 'card' | 'tile';
  /**
   * Optional JSX rendered ON TOP of the image preview as a WYSIWYG
   * stand-in for live-site chrome that obscures part of the slot —
   * e.g. the homepage hero is partly covered by a `position: fixed`
   * navbar and a bottom gradient, so an image picked in the editor
   * looks different in the wild. Inject the equivalent overlay here
   * and the editor preview becomes a true 1:1 representation.
   *
   * Z-order inside the preview button:
   *   image  →  chromeOverlay  →  hover/focus edit affordance  →  upload spinner
   *
   * `pointer-events-none` is applied for you, so chrome cannot
   * accidentally intercept clicks meant for the file picker.
   */
  chromeOverlay?: React.ReactNode;
}

/**
 * Self-contained upload tile.
 *
 * Wire contract:
 *   - Posts multipart `FormData` to /api/upload with two fields:
 *       * `file` (Blob)   — the chosen image
 *       * `id`   (string) — the imageId prop (the route's primary key)
 *   - On success, calls router.refresh() so the parent server component
 *     re-fetches `site_images` and the new URL flows back into this
 *     component via the `currentUrl` prop. No client-side state for the
 *     URL itself — the server is the single source of truth.
 *
 * Interaction:
 *   - The image (or empty-state placeholder) is itself a `<button>`. On
 *     hover, a translucent dark overlay fades in with a pencil icon to
 *     telegraph editability. Click opens the native file picker.
 *   - Keyboard accessible: the button gets a visible focus ring, and
 *     Enter / Space activate the picker the same way a mouse click does.
 *   - During upload the overlay is forced on with "Uploading…" copy so
 *     the user gets immediate feedback before the network round trip
 *     completes.
 *
 * Error handling:
 *   - Network failures and 4xx/5xx responses both surface a short error
 *     message under the image. We DO NOT clear the file input on error
 *     so the user can retry without re-picking the file.
 */
export default function ImageUploader({
  imageId,
  currentUrl,
  label,
  aspectClass = 'aspect-video',
  className,
  variant = 'card',
  chromeOverlay,
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
        let detail = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* non-JSON body — keep statusText */
        }
        throw new Error(detail || 'upload_failed');
      }

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
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const isCard = variant === 'card';

  // ── Clickable image area (shared between both variants) ─────────────
  // Wrapped in a real <button> so it picks up keyboard focus, hits
  // assistive-tech announcement paths, and inherits :hover / :focus
  // states for the overlay transition (`group-hover` / `group-focus`).
  const clickableImage = (
    <button
      type="button"
      onClick={triggerPicker}
      disabled={isUploading}
      aria-label={`Replace ${label}`}
      className={`group relative block w-full cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 disabled:cursor-progress ${
        isCard ? 'rounded-md' : 'h-full'
      }`}
    >
      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={label}
          className={`${aspectClass} block w-full object-cover ${
            isCard ? 'bg-stone-100' : 'h-full'
          }`}
        />
      ) : (
        <div
          className={`flex ${aspectClass} w-full items-center justify-center ${
            isCard ? 'bg-stone-100' : 'h-full bg-[#1C2E42]'
          }`}
        >
          <ImageIcon
            className={`h-8 w-8 ${
              isCard ? 'text-stone-300' : 'text-white/30'
            }`}
            aria-hidden="true"
          />
        </div>
      )}

      {/*
        Live-site chrome (nav band, gradient overlay, etc.). Rendered
        UNDER the hover overlay so the editor sees the chrome at rest
        and the chrome stays visible (slightly dimmed) when the user
        hovers to click. `pointer-events-none` so it never steals the
        click from the parent button.
      */}
      {chromeOverlay && (
        <div className="pointer-events-none absolute inset-0">
          {chromeOverlay}
        </div>
      )}

      {/*
        Hover/focus overlay — the visual cue that the image is editable.
        Transitions in on group-hover/group-focus; forced on during
        upload (via the sibling render below).

        `pointer-events-none` keeps the click target on the parent button
        rather than the overlay, so the cursor reports the button state
        (pointer / progress) consistently.
      */}
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/0 transition-all duration-200 group-hover:bg-black/45 group-focus-visible:bg-black/45`}
      >
        <Pencil
          className="h-6 w-6 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
        {!isCard && (
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            {label}
          </span>
        )}
      </div>

      {/* Forced-on overlay while the request is in flight. */}
      {isUploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-medium uppercase tracking-[0.2em] text-white">
          Uploading…
        </div>
      )}
    </button>
  );

  // ── Hidden native file input (shared) ───────────────────────────────
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={handleFileChange}
    />
  );

  // ── CARD variant ────────────────────────────────────────────────────
  if (isCard) {
    return (
      <div
        className={`flex flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm ${
          className ?? ''
        }`}
      >
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-stone-500">
          {label}
        </h3>
        {clickableImage}
        {fileInput}
        {errorMsg && (
          <p className="mt-2 text-xs text-rose-700" role="alert">
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  // ── TILE variant — edge-to-edge, no chrome (mirrors live .p-item) ───
  // The wrapper is `relative` so the error toast can be absolutely
  // positioned over the image without disturbing the grid cell. The
  // root has no padding, no border, no background of its own — the
  // image fills the cell exactly the way `.p-item img { width:100%;
  // height:100% }` does on the live site.
  return (
    <div className={`relative overflow-hidden bg-[#1C2E42] ${className ?? ''}`}>
      {clickableImage}
      {fileInput}
      {errorMsg && (
        <p
          className="absolute inset-x-2 bottom-2 rounded bg-rose-900/95 px-2 py-1 text-xs text-rose-50 shadow"
          role="alert"
        >
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
    case 'image_processing_failed':
      return 'That image could not be processed. Try a different file.';
    case 'db_upsert_failed':
      return 'Upload saved but the website record did not update. Please try again.';
    default:
      return `Upload failed (${detail}).`;
  }
}
