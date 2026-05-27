'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Cropper, { type Area } from 'react-easy-crop';
import { Check, ImageIcon, Loader2, Pencil, X } from 'lucide-react';

import { getCroppedImageFile } from '@/lib/cropImage';

interface Props {
  /** Stable key into `site_images.id` — also drives the blob pathname. */
  imageId: string;
  /** Current public URL, or null if nothing's been uploaded yet. */
  currentUrl: string | null;
  /**
   * Editorial label shown above the preview (card) or as the
   * default tile hover label when no custom caption has been set.
   *
   * For card variant: also the admin-facing slot name shown above
   * the preview ("Homepage Hero Image", "About Section Portrait")
   * — these don't render on the public site and aren't editable.
   *
   * For tile variant: serves as the FALLBACK p-tag text — public
   * site shows the custom `initialCaption` if set, otherwise this.
   */
  label: string;
  /**
   * Persisted custom caption from `site_images.caption`. Null when
   * the admin hasn't saved a value yet (the live site falls back
   * to the hardcoded `.p-tag` text in `public/index.html`, which
   * matches `label` for portfolio tiles).
   *
   * Only the `tile` variant exposes an editor for this — the Core
   * Pages cards have no subtitle on the public site and ignore the
   * prop if it's accidentally passed.
   */
  initialCaption?: string | null;
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
  initialCaption = null,
  aspectClass = 'aspect-video',
  className,
  variant = 'card',
  chromeOverlay,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ref to the clickable image button so we can measure its
  // bounding rect at the moment the user picks a file. The cropper
  // adopts that exact aspect ratio so the admin can only commit a
  // crop that matches the live slot's shape (4:5 hero, 3:4 about
  // portrait, whatever the portfolio grid cell happens to be).
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSavingCaption, setIsSavingCaption] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Optimistic display URL — lets the tile swap to the freshly
  // uploaded image the INSTANT the POST succeeds, without waiting
  // for `router.refresh()` to round-trip the server component and
  // hand us a new `currentUrl` prop. We seed from prop and re-sync
  // whenever the prop changes (so if some other tab updates the
  // same slot, our display still reflects the canonical server
  // value once the refresh completes).
  const [displayUrl, setDisplayUrl] = useState<string | null>(currentUrl);
  useEffect(() => {
    setDisplayUrl(currentUrl);
  }, [currentUrl]);

  // Same pattern for the persisted caption. Null = "no custom
  // caption set, fall back to the hardcoded p-tag text in
  // public/index.html" (which matches the `label` prop for
  // portfolio tiles). When the editor saves a non-empty value via
  // the cropper input, we flip this to the new string and the tile
  // hover label updates instantly.
  const [savedCaption, setSavedCaption] = useState<string | null>(
    initialCaption
  );
  useEffect(() => {
    setSavedCaption(initialCaption);
  }, [initialCaption]);

  // Working draft the cropper input writes to. Initialised from
  // the persisted caption every time the cropper opens (see
  // handleFileChange below) so cancelling a crop doesn't bleed an
  // unsaved draft into a future session.
  const [captionDraft, setCaptionDraft] = useState<string>('');

  // Caption editing is only meaningful for the tile variant —
  // Core Pages cards don't render a subtitle on the public site.
  // Cropper UI gates the input on this flag.
  const captionEditable = variant === 'tile';

  // Tile hover overlay mirrors the public `.p-tag` contract:
  //   • savedCaption === null → show the hardcoded default (`label`)
  //   • savedCaption === ''   → hide overlay (explicit clear)
  //   • non-empty string      → show the custom caption
  const ptagText = captionEditable
    ? savedCaption === null
      ? label
      : savedCaption.trim()
    : label;
  const showPtagOverlay = captionEditable && ptagText.length > 0;

  // ── Cropper state ─────────────────────────────────────────────
  // `imageToCrop` is an object URL we own and must revoke when
  // we're done with it (handled by the useEffect cleanup below).
  // `originalFileName` is the picked file's original name so the
  // post-crop File gets a sensible `.jpg` filename rather than a
  // generic placeholder.
  const [imageToCrop, setImageToCrop] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string>('image.jpg');
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(
    null
  );
  // Slot aspect ratio (width / height) sampled at cropper-open
  // time. Falls back to 1 if measurement fails (e.g. the button
  // hadn't laid out yet) — never blocks the flow.
  const [cropAspect, setCropAspect] = useState<number>(1);

  // Revoke the object URL whenever it changes (cleanup of the
  // previous one) or on unmount. Without this we'd leak the
  // decoded image in browser memory until the tab closes.
  useEffect(() => {
    return () => {
      if (imageToCrop) URL.revokeObjectURL(imageToCrop);
    };
  }, [imageToCrop]);

  const triggerPicker = () => {
    if (isUploading || isSavingCaption || imageToCrop) return;
    inputRef.current?.click();
  };

  const openEditModal = () => {
    if (isUploading || isSavingCaption || imageToCrop) return;
    setErrorMsg(null);
    setCaptionDraft(
      savedCaption === null || savedCaption === undefined ? '' : savedCaption
    );
    setEditOpen(true);
  };

  const closeEditModal = () => {
    if (isUploading || isSavingCaption) return;
    setEditOpen(false);
  };

  const saveCaptionOnly = useCallback(async () => {
    setIsSavingCaption(true);
    setErrorMsg(null);
    try {
      const trimmed = captionDraft.trim();
      const res = await fetch('/api/admin/website/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: imageId,
          caption: trimmed.length > 0 ? trimmed : '',
        }),
      });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || 'caption_save_failed');
      }
      const data = (await res.json()) as {
        slot: { caption: string | null };
      };
      setSavedCaption(data.slot.caption);
      setEditOpen(false);
      router.refresh();
    } catch (err) {
      console.error('[ImageUploader] caption save failed:', err);
      setErrorMsg(
        err instanceof Error
          ? humaniseUploadError(err.message)
          : 'Could not save caption. Please try again.'
      );
    } finally {
      setIsSavingCaption(false);
    }
  }, [captionDraft, imageId, router]);

  // STAGE 1: file picked → open cropper. NO upload here.
  // We measure the rendered slot's aspect ratio first so the
  // cropper can constrain the user to the live shape; this is the
  // whole point of cropping inside the CMS — the editor sees what
  // the public site will see.
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input immediately so the same file can be picked
    // again next time (browsers don't fire `change` for identical
    // re-select).
    e.target.value = '';
    if (!file) return;

    setErrorMsg(null);

    // Sample the slot aspect at this exact moment. Bounding rect
    // works for both variants: card has an aspect-class image
    // inside, tile has `h-full` so it adopts the grid cell.
    const rect = buttonRef.current?.getBoundingClientRect();
    const sampled =
      rect && rect.width > 0 && rect.height > 0
        ? rect.width / rect.height
        : 1;
    setCropAspect(sampled);

    // Reset crop state every time we open the cropper so the
    // image starts perfectly centred and unzoomed.
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);

    setOriginalFileName(file.name);
    // When the slot editor is open, keep the in-modal caption draft;
    // otherwise seed from the persisted value for a standalone replace.
    if (!editOpen) {
      setCaptionDraft(
        savedCaption === null || savedCaption === undefined ? '' : savedCaption
      );
    }
    setImageToCrop(URL.createObjectURL(file));
  };

  const onCropComplete = useCallback((_area: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleCancelCrop = useCallback(() => {
    if (isUploading) return; // don't yank the cropper mid-upload
    setImageToCrop(null);
    setCroppedAreaPixels(null);
  }, [isUploading]);

  // Extracted from the previous handleFileChange. Runs the actual
  // server round-trip given an arbitrary File + optional caption.
  //
  // Returns the parsed response so the caller can update the
  // tile preview AND the saved caption optimistically (router
  // .refresh() also fires here, but it's async and we don't want
  // the UI to wait on the server re-render to show the new state).
  //
  // Caption semantics:
  //   • `undefined` → don't send the caption field at all; the
  //     server preserves whatever it had stored.
  //   • `string`    → send (possibly empty) so the server overwrites.
  //     Empty/whitespace-only ends up as NULL in the DB (cleared).
  const uploadFile = useCallback(
    async (
      file: File,
      caption?: string
    ): Promise<{ url: string; caption?: string | null }> => {
      setIsUploading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('id', imageId);
        if (caption !== undefined) {
          form.append('caption', caption);
        }

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

        const data = (await res.json()) as {
          url: string;
          id: string;
          caption?: string | null;
        };
        // Fire-and-forget — re-fetches the server component so any
        // OTHER on-page consumer of `site_images` (e.g. a sibling
        // uploader showing the same slot) stays consistent. Our own
        // tile updates immediately via the returned values below.
        router.refresh();
        return { url: data.url, caption: data.caption };
      } finally {
        setIsUploading(false);
      }
    },
    [imageId, router]
  );

  // STAGE 2: admin confirmed crop → produce the cropped File,
  // upload it (along with the caption draft), then dismiss the
  // cropper. On failure we leave the cropper open so they can
  // retry without re-picking the file.
  const handleConfirmCrop = useCallback(async () => {
    if (!imageToCrop || !croppedAreaPixels) return;
    setErrorMsg(null);
    try {
      const file = await getCroppedImageFile(
        imageToCrop,
        croppedAreaPixels,
        originalFileName
      );
      // Caption is only sent for tile-variant slots — the card
      // variant has no editor, and sending an empty string for
      // those would clobber any value that somehow got into the
      // DB out-of-band.
      const captionToSend = captionEditable ? captionDraft : undefined;
      const result = await uploadFile(file, captionToSend);
      // Swap the tile preview to the new image immediately. The
      // subsequent router.refresh() (fired inside uploadFile) will
      // hand us the same URL via `currentUrl` a moment later — the
      // useEffect above keeps the two in sync without flicker.
      setDisplayUrl(result.url);
      // Same optimistic pattern for the caption: trust the server
      // echo (so a trimmed-to-empty draft correctly clears the
      // overlay) and resync from the prop after refresh.
      if (captionEditable && result.caption !== undefined) {
        setSavedCaption(result.caption);
      }
      setImageToCrop(null);
      setCroppedAreaPixels(null);
      setEditOpen(false);
    } catch (err) {
      console.error('[ImageUploader] upload failed:', err);
      setErrorMsg(
        err instanceof Error
          ? humaniseUploadError(err.message)
          : 'Upload failed. Please try again.'
      );
    }
  }, [
    imageToCrop,
    croppedAreaPixels,
    originalFileName,
    captionDraft,
    captionEditable,
    uploadFile,
  ]);

  const isCard = variant === 'card';

  // ── Clickable image area (shared between both variants) ─────────────
  // Wrapped in a real <button> so it picks up keyboard focus, hits
  // assistive-tech announcement paths, and inherits :hover / :focus
  // states for the overlay transition (`group-hover` / `group-focus`).
  //
  // TILE variant — pixel-mirror of public/css/styles.css `.p-item`:
  //   • saturate(0.82) filter on the image (matches the brand's slightly
  //     desaturated, film-print feel)
  //   • slow 0.9s cubic-bezier(0.25,0.46,0.45,0.94) transition on the
  //     image transform, with a hover scale of 1.06
  //   • `.p-tag` bottom-gradient label that fades + slides in on hover
  //     (replacing the centered pencil+label hover overlay used in the
  //     card variant)
  //   • a subtle top-right pencil badge — the only editor affordance
  //     we add on top of the live look, so the admin can still tell
  //     the tile is clickable. Sized/positioned to read as a corner
  //     UI affordance, not a content overlay.
  const tileBusy = isUploading || isSavingCaption || !!imageToCrop;

  const imageSurface = (
    <>
      {displayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayUrl}
          alt={label}
          className={`block w-full object-cover ${
            isCard
              ? `${aspectClass} bg-stone-100`
              : 'h-full max-[860px]:aspect-video max-[860px]:h-auto saturate-[0.82] transition-transform duration-900 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] group-hover:scale-[1.06] group-focus-visible:scale-[1.06]'
          }`}
        />
      ) : (
        <div
          className={`flex w-full items-center justify-center ${
            isCard
              ? `${aspectClass} bg-stone-100`
              : 'h-full max-[860px]:aspect-video max-[860px]:h-auto bg-[#1C2E42]'
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

      {chromeOverlay && (
        <div className="pointer-events-none absolute inset-0">
          {chromeOverlay}
        </div>
      )}

      {isCard && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/0 transition-all duration-200 group-hover:bg-black/45 group-focus-visible:bg-black/45">
          <Pencil
            className="h-6 w-6 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        </div>
      )}

      {!isCard && showPtagOverlay && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-[6px] bg-linear-to-t from-[rgba(13,27,42,0.85)] to-transparent px-[18px] pb-[14px] pt-[24px] font-sans text-[0.58rem] font-light uppercase tracking-[0.22em] text-[rgba(245,243,240,0.8)] opacity-0 transition-[opacity,transform] duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
        >
          {ptagText}
        </div>
      )}

      {isUploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-medium uppercase tracking-[0.2em] text-white">
          Uploading…
        </div>
      )}
    </>
  );

  // Tile: pencil is a sibling button (never nested inside the image
  // button — invalid HTML and a React hydration error).
  const clickableImage = isCard ? (
    <button
      type="button"
      ref={buttonRef}
      onClick={triggerPicker}
      disabled={tileBusy}
      aria-label={`Replace ${label}`}
      className="group relative block w-full cursor-pointer overflow-hidden rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 disabled:cursor-progress"
    >
      {imageSurface}
    </button>
  ) : (
    <div className="relative h-full w-full max-[860px]:h-auto">
      <button
        type="button"
        ref={buttonRef}
        onClick={openEditModal}
        disabled={tileBusy}
        aria-label={`Edit ${label}`}
        className="group relative block h-full w-full cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 disabled:cursor-progress"
      >
        {imageSurface}
      </button>
      <button
        type="button"
        onClick={openEditModal}
        disabled={tileBusy}
        aria-label={`Edit ${label}`}
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 opacity-70 backdrop-blur-sm transition-opacity duration-200 hover:bg-black/55 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 max-[860px]:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Pencil className="h-3.5 w-3.5 text-white" aria-hidden="true" />
      </button>
    </div>
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

  // Shared crop overlay — both variants render the same modal when
  // a file is mid-crop. Rendered as a portal-like fixed overlay so
  // it sits on top of every uploader on the page, not just inside
  // the current card / tile.
  const cropOverlay = imageToCrop && (
    <CropperOverlay
      imageSrc={imageToCrop}
      aspect={cropAspect}
      label={label}
      crop={crop}
      zoom={zoom}
      onCropChange={setCrop}
      onZoomChange={setZoom}
      onCropComplete={onCropComplete}
      onCancel={handleCancelCrop}
      onConfirm={handleConfirmCrop}
      isUploading={isUploading}
      canConfirm={!!croppedAreaPixels}
    />
  );

  const slotEditModal =
    captionEditable &&
    editOpen && (
      <SlotEditModal
        label={label}
        displayUrl={displayUrl}
        captionDraft={captionDraft}
        onCaptionDraftChange={setCaptionDraft}
        captionPlaceholder={label}
        onClose={closeEditModal}
        onChangeImage={triggerPicker}
        onSaveCaption={saveCaptionOnly}
        isSaving={isSavingCaption}
        isUploading={isUploading}
        errorMsg={errorMsg}
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
        {cropOverlay}
        {slotEditModal}
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
      {cropOverlay}
      {slotEditModal}
    </div>
  );
}

/**
 * Portfolio tile editor — image swap + caption without forcing a crop
 * when only the title changes. Opened from the pencil badge or by
 * clicking the tile.
 */
function SlotEditModal({
  label,
  displayUrl,
  captionDraft,
  onCaptionDraftChange,
  captionPlaceholder,
  onClose,
  onChangeImage,
  onSaveCaption,
  isSaving,
  isUploading,
  errorMsg,
}: {
  label: string;
  displayUrl: string | null;
  captionDraft: string;
  onCaptionDraftChange: (next: string) => void;
  captionPlaceholder: string;
  onClose: () => void;
  onChangeImage: () => void;
  onSaveCaption: () => void;
  isSaving: boolean;
  isUploading: boolean;
  errorMsg: string | null;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (isSaving || isUploading) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSaving, isUploading, onClose]);

  const busy = isSaving || isUploading;
  const previewCaption = captionDraft.trim();

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${label}`}
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h3 className="font-serif text-lg text-stone-900">Edit · {label}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close editor"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-video w-full overflow-hidden bg-[#1C2E42]">
          {displayUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayUrl}
              alt={label}
              className="h-full w-full object-cover saturate-[0.82]"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <ImageIcon className="h-10 w-10 text-white/30" aria-hidden="true" />
            </div>
          )}
          {previewCaption.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 font-sans text-[0.58rem] font-light uppercase tracking-[0.22em] text-[#f5f3f0]/80">
              {previewCaption}
            </div>
          )}
        </div>

        <div className="space-y-4 px-4 py-4">
          <button
            type="button"
            onClick={onChangeImage}
            disabled={busy}
            className="w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Change image…
          </button>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Image Title / Caption
            </span>
            <input
              type="text"
              value={captionDraft}
              onChange={(e) => onCaptionDraftChange(e.target.value)}
              disabled={busy}
              placeholder={captionPlaceholder}
              maxLength={300}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500/40 disabled:opacity-50"
            />
            <span className="text-[11px] text-stone-500">
              Shown on hover on the live site. Leave blank to hide the label
              and gradient for this tile.
            </span>
          </label>

          {errorMsg && (
            <p className="text-xs text-rose-700" role="alert">
              {errorMsg}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-stone-200 bg-stone-50 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSaveCaption}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Check className="h-4 w-4" strokeWidth={2} />
                Save
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen cropper overlay. Premium dark-stone surface matching
 * the admin's neutral palette (no rose/blue chrome). Backdrop click
 * is intentionally inert — cropping requires a deliberate
 * commit/cancel, not an accidental dismissal.
 *
 * The crop area mirrors the live slot's aspect ratio so the editor
 * can only ship something that will look right on the public site.
 * If the slot is portrait (4:5, 3:4) the crop frame is portrait; if
 * landscape (portfolio tiles, hero on mobile) it's landscape.
 */
function CropperOverlay({
  imageSrc,
  aspect,
  label,
  crop,
  zoom,
  onCropChange,
  onZoomChange,
  onCropComplete,
  onCancel,
  onConfirm,
  isUploading,
  canConfirm,
}: {
  imageSrc: string;
  aspect: number;
  label: string;
  crop: { x: number; y: number };
  zoom: number;
  onCropChange: (crop: { x: number; y: number }) => void;
  onZoomChange: (zoom: number) => void;
  onCropComplete: (area: Area, pixels: Area) => void;
  onCancel: () => void;
  onConfirm: () => void;
  isUploading: boolean;
  canConfirm: boolean;
}) {
  // ESC closes the cropper unless an upload is in flight — never
  // let the user dismiss UI while a network request is still
  // mid-air.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (isUploading) return;
      onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isUploading, onCancel]);

  // Make the crop canvas a sensible size relative to the viewport:
  //   • Portrait slots (aspect < 1): cap height, derive width.
  //   • Landscape slots (aspect ≥ 1): cap width, derive height.
  // Keeps the cropper visually centred and never overflows on
  // 13-inch laptops or scales pathologically small on 4K.
  const canvasStyle: React.CSSProperties =
    aspect < 1
      ? { height: 'min(72vh, 560px)', aspectRatio: `${aspect}` }
      : { width: 'min(72vw, 720px)', aspectRatio: `${aspect}` };

  return (
    <div
      // z-110 keeps us above any other admin chrome. Backdrop is
      // dark-stone with a slight blur so the editor sees only the
      // cropping task while it's active.
      className="fixed inset-0 z-110 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Crop ${label}`}
    >
      <div className="flex w-auto max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-stone-800 bg-stone-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-6 border-b border-stone-800/80 px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-serif text-base leading-tight text-stone-100">
              Crop · {label}
            </h3>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.2em] text-stone-500">
              Drag to reposition · scroll or slide to zoom
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            aria-label="Cancel crop"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-stone-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Crop canvas. `position: relative` is required by
            react-easy-crop (it positions its layers absolutely
            inside this container). Aspect ratio is locked to the
            live slot via inline style above. */}
        <div className="relative bg-stone-900" style={canvasStyle}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            cropShape="rect"
            showGrid={true}
            objectFit="contain"
            onCropChange={onCropChange}
            onZoomChange={onZoomChange}
            onCropComplete={onCropComplete}
            minZoom={1}
            maxZoom={4}
            zoomSpeed={0.5}
            classes={{
              containerClassName: 'bg-stone-900',
              mediaClassName: 'select-none',
            }}
          />

          {isUploading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-sm">
              <Loader2 className="h-7 w-7 animate-spin text-stone-100" />
              <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-stone-200">
                Uploading
              </span>
            </div>
          )}
        </div>

        {/* Zoom slider. Native range input with the stone palette so
            it sits naturally on the dark surface. */}
        <div className="border-t border-stone-800/80 px-5 py-3.5">
          <label className="flex items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
              Zoom
            </span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => onZoomChange(Number(e.target.value))}
              disabled={isUploading}
              aria-label="Zoom level"
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-stone-700 accent-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="w-10 text-right font-mono text-[11px] tabular-nums text-stone-400">
              {zoom.toFixed(1)}×
            </span>
          </label>
        </div>

        {/* Footer — Cancel + Confirm. Cream primary on stone matches
            the admin's neutral aesthetic; no rose/blue accents. */}
        <div className="flex items-center justify-end gap-2 border-t border-stone-800/80 bg-stone-900/60 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            className="rounded-md border border-stone-700 bg-transparent px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isUploading || !canConfirm}
            className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-900 shadow-sm transition-colors hover:bg-white focus:outline-none focus:ring-2 focus:ring-stone-300/50 focus:ring-offset-2 focus:ring-offset-stone-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Uploading…</span>
              </>
            ) : (
              <>
                <Check className="h-4 w-4" strokeWidth={2} />
                <span>Confirm crop</span>
              </>
            )}
          </button>
        </div>
      </div>
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
    case 'caption_save_failed':
    case 'db_update_failed':
      return 'Could not save the caption. Please try again.';
    case 'slot_not_found':
      return 'Upload an image for this slot before saving a caption.';
    default:
      return `Upload failed (${detail}).`;
  }
}
