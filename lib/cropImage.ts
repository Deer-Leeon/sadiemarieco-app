/**
 * cropImage — canvas-based cropper used by the admin photo upload
 * flow.
 *
 * react-easy-crop intentionally doesn't ship a cropping function;
 * it only emits the chosen crop *boundary* (in source-image
 * pixels) via `onCropComplete`. Turning that boundary into a real
 * File is the consumer's job, and this helper is the standard
 * canvas boilerplate from react-easy-crop's docs adapted to:
 *
 *   • return a real `File` (not a `Blob`) so the existing
 *     browser-image-compression → FormData pipeline downstream
 *     doesn't need to re-wrap.
 *   • re-use the source filename (extension swapped to .jpg) so
 *     the server's `${Date.now()}-${rand}-${name}` blob key stays
 *     deterministic and the stored object's extension matches its
 *     bytes (we always re-encode as JPEG).
 *   • encode at JPEG q=0.92, the same quality our HEIC → JPEG
 *     fallback uses, so a cropped photo is visually identical to
 *     a non-cropped one at the same resolution.
 *
 * Source orientation: the `imageSrc` passed in is always an
 * already-decoded object URL (HEIC has been re-encoded to JPEG
 * upstream), so we don't need to handle EXIF rotation here — the
 * browser has already baked it in by the time the <Cropper /> got
 * the URL.
 */

export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draw `imageSrc` cropped to `pixelCrop` onto a canvas and return
 * the resulting JPEG as a `File`. `originalName` is the source
 * file's original filename — we swap its extension to `.jpg`
 * (preserving the stem) so the uploaded blob is named sensibly.
 */
export async function getCroppedImageFile(
  imageSrc: string,
  pixelCrop: CropArea,
  originalName: string
): Promise<File> {
  const image = await loadImage(imageSrc);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pixelCrop.width);
  canvas.height = Math.round(pixelCrop.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not obtain 2D canvas context');

  // 9-arg drawImage: copy `pixelCrop` (in source-image coords)
  // into the canvas at native size. The canvas already matches
  // pixelCrop's dimensions so no scaling happens here — quality
  // loss is limited to the JPEG re-encode below.
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92)
  );
  if (!blob) throw new Error('Canvas → JPEG export returned empty blob');

  const targetName = swapExtensionToJpg(originalName);
  return new File([blob], targetName, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Object URLs are same-origin; setting crossOrigin avoids
    // canvas taint warnings if a future caller ever passes a
    // remote URL by accident.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Failed to load image for cropping'));
    img.src = src;
  });
}

function swapExtensionToJpg(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}.jpg`;
  return `${name.slice(0, dot)}.jpg`;
}
