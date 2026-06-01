/** Crop transparent padding so exports match the ink the user drew. */
const ALPHA_THRESHOLD = 12;
const PAD_CSS_PX = 8;

export function trimSignatureCanvasToDataUrl(
  source: HTMLCanvasElement
): string {
  const ctx = source.getContext('2d', { willReadFrequently: true });
  if (!ctx) return source.toDataURL('image/png');

  const { width, height } = source;
  const { data } = ctx.getImageData(0, 0, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]!;
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return source.toDataURL('image/png');
  }

  const cssWidth = parseFloat(source.style.width) || width;
  const padPx = Math.max(
    2,
    Math.round(PAD_CSS_PX * (width / Math.max(cssWidth, 1)))
  );

  minX = Math.max(0, minX - padPx);
  minY = Math.max(0, minY - padPx);
  maxX = Math.min(width - 1, maxX + padPx);
  maxY = Math.min(height - 1, maxY + padPx);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  const outCtx = out.getContext('2d');
  if (!outCtx) return source.toDataURL('image/png');

  outCtx.drawImage(source, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return out.toDataURL('image/png');
}
