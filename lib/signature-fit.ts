/**
 * Shared signature placement + aspect-fit math for PDF stamp and canvas preview.
 * Coordinates use PDF points (612×792) unless noted as viewport/CSS pixels.
 */

export const PAGE_WIDTH_PT = 612;
export const PAGE_HEIGHT_PT = 792;

/** Fine-tune onto the printed signature dotted line (PDF points). */
export const SIGNATURE_NUDGE_PT = {
  x: 2,
  y: -4,
} as const;

/** Fallback signature box (PDF bottom-left origin). `y` is the dotted baseline. */
export const SIGNATURE_BOX_PT = {
  x: 118 + SIGNATURE_NUDGE_PT.x,
  y: 438 + SIGNATURE_NUDGE_PT.y,
  width: 230,
  height: 40,
} as const;

export type Box = { x: number; y: number; width: number; height: number };

/** Fit image inside a box without stretching; avoid upscaling past native resolution. */
export function fitImageDimensions(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number,
  maxHeight: number,
  options?: { allowUpscale?: boolean }
): { width: number; height: number } {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  let scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight);
  if (!options?.allowUpscale) {
    scale = Math.min(scale, 1);
  }
  return {
    width: imageWidth * scale,
    height: imageHeight * scale,
  };
}

type PlaceImageOptions = {
  /** PDF drawImage uses bottom-left; canvas preview uses top-left. */
  origin?: 'bottom-left' | 'top-left';
};

/** Left-align; bottom of signature sits on the box baseline (dotted line). */
export function placeImageInBox(
  box: Box,
  imageSize: { width: number; height: number },
  options?: PlaceImageOptions
): Box {
  const { width, height } = imageSize;
  const origin = options?.origin ?? 'bottom-left';

  if (origin === 'top-left') {
    return {
      x: box.x,
      y: box.y + box.height - height,
      width,
      height,
    };
  }

  return {
    x: box.x,
    y: box.y,
    width,
    height,
  };
}

/** Placement box for stamping (PDF bottom-left origin). Preview uses the same values. */
export function signaturePlacementBox(): Box {
  return {
    x: SIGNATURE_BOX_PT.x,
    y: SIGNATURE_BOX_PT.y,
    width: SIGNATURE_BOX_PT.width,
    height: SIGNATURE_BOX_PT.height,
  };
}

/** Max area above the dotted line on a PDF.js viewport (top-left origin). */
export function signatureBoxInViewport(viewport: {
  width: number;
  height: number;
}): Box {
  const px = viewport.width / PAGE_WIDTH_PT;
  const lineFromTop = PAGE_HEIGHT_PT - SIGNATURE_BOX_PT.y;
  const lineY = viewport.height * (lineFromTop / PAGE_HEIGHT_PT);
  const boxH = SIGNATURE_BOX_PT.height * px;
  return {
    x: SIGNATURE_BOX_PT.x * px,
    y: lineY - boxH,
    width: SIGNATURE_BOX_PT.width * px,
    height: boxH,
  };
}
