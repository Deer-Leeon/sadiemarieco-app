'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  fitImageDimensions,
  placeImageInBox,
  signatureBoxInViewport,
} from '@/lib/signature-fit';

/** Cap backing-store scale so 3× Retina stays sharp without huge canvases. */
const MAX_OUTPUT_SCALE = 3;

type PageViewport = { width: number; height: number };

type LastPageState = {
  canvas: HTMLCanvasElement;
  baseImageData: ImageData;
  logicalViewport: PageViewport;
  outputScale: number;
};

function getOutputScale(): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
}

interface Props {
  pdfBase64: string;
  signatureImageSrc?: string | null;
  onReadyChange?: (ready: boolean) => void;
}

async function drawSignatureOnCanvas(
  ctx: CanvasRenderingContext2D,
  viewport: PageViewport,
  signatureImageSrc: string
): Promise<void> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load signature image'));
    img.src = signatureImageSrc;
  });

  const maxBox = signatureBoxInViewport(viewport);
  const fitted = fitImageDimensions(
    img.naturalWidth,
    img.naturalHeight,
    maxBox.width,
    maxBox.height
  );
  const dest = placeImageInBox(maxBox, fitted, { origin: 'top-left' });

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, dest.x, dest.y, dest.width, dest.height);
}

async function applySignatureToLastPage(
  lastPage: LastPageState,
  signatureImageSrc: string | null | undefined
): Promise<void> {
  const ctx = lastPage.canvas.getContext('2d');
  if (!ctx) return;

  ctx.putImageData(lastPage.baseImageData, 0, 0);

  if (signatureImageSrc) {
    ctx.save();
    ctx.scale(lastPage.outputScale, lastPage.outputScale);
    await drawSignatureOnCanvas(
      ctx,
      lastPage.logicalViewport,
      signatureImageSrc
    );
    ctx.restore();
  }
}

export default function ConsentPdfScrollViewer({
  pdfBase64,
  signatureImageSrc,
  onReadyChange,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const lastPageRef = useRef<LastPageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Full render only when the PDF bytes change — not when signature changes.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    lastPageRef.current = null;
    setReady(false);
    setError(null);
    setLoading(true);

    async function renderPdf() {
      try {
        const pdfjs = await import('pdfjs-dist');
        if (cancelled) return;

        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

        const binary = atob(pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;

        const root = mountRef.current;
        if (!root || cancelled) return;

        const containerWidth = root.clientWidth || window.innerWidth;
        const shell = document.createElement('div');
        shell.className = 'w-full space-y-6';

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          if (cancelled) return;

          const baseViewport = page.getViewport({ scale: 1 });
          const displayScale = Math.min(
            (containerWidth - 8) / baseViewport.width,
            2
          );
          const viewport = page.getViewport({ scale: displayScale });
          const outputScale = getOutputScale();
          const logicalViewport: PageViewport = {
            width: viewport.width,
            height: viewport.height,
          };

          const isLast = pageNum === pdf.numPages;
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', {
            willReadFrequently: isLast,
          });
          if (!ctx) continue;

          const pixelWidth = Math.floor(viewport.width * outputScale);
          const pixelHeight = Math.floor(viewport.height * outputScale);
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;

          const transform =
            outputScale !== 1
              ? [outputScale, 0, 0, outputScale, 0, 0]
              : undefined;

          await page.render({
            canvasContext: ctx,
            viewport,
            transform,
          }).promise;
          if (cancelled) return;

          if (isLast) {
            const baseImageData = ctx.getImageData(
              0,
              0,
              pixelWidth,
              pixelHeight
            );
            lastPageRef.current = {
              canvas,
              baseImageData,
              logicalViewport,
              outputScale,
            };
            if (signatureImageSrc) {
              ctx.save();
              ctx.scale(outputScale, outputScale);
              await drawSignatureOnCanvas(
                ctx,
                logicalViewport,
                signatureImageSrc
              );
              ctx.restore();
            }
          }

          const wrap = document.createElement('div');
          wrap.className = 'mx-auto max-w-full overflow-hidden rounded-sm bg-white shadow-md';
          canvas.className = 'mx-auto block h-auto max-w-full';
          wrap.appendChild(canvas);
          shell.appendChild(wrap);
        }

        if (cancelled) return;
        root.replaceChildren(shell);
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not display PDF');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
    };
  }, [pdfBase64]);

  // Update signature on the last page without re-rendering the whole document.
  useEffect(() => {
    if (!ready || !lastPageRef.current) return;
    let cancelled = false;

    void applySignatureToLastPage(lastPageRef.current, signatureImageSrc).catch(
      (err) => {
        if (!cancelled) {
          console.warn('[ConsentPdfScrollViewer] signature overlay failed:', err);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [signatureImageSrc, ready]);

  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange]);

  return (
    <div className="relative w-full min-h-[40vh]">
      {loading && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-stone-300/40"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading document…
          </div>
        </div>
      )}
      {error && (
        <p className="py-12 text-center text-sm text-rose-700">{error}</p>
      )}
      <div
        ref={mountRef}
        className={`w-full px-1 transition-opacity duration-200 ${
          ready && !loading ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden={!ready || loading}
      />
    </div>
  );
}
