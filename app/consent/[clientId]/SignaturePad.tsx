'use client';

import { Great_Vibes } from 'next/font/google';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { trimSignatureCanvasToDataUrl } from '@/lib/signature-trim';

const signatureScript = Great_Vibes({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
});

export type SignaturePadHandle = {
  clear: () => void;
  isEmpty: () => boolean;
  toDataURL: () => string | null;
};

type SignatureMode = 'draw' | 'type';

type SignaturePadProps = {
  onStroke?: () => void;
};

const CANVAS_HEIGHT_CSS = 200;
const MAX_DPR = 3;
const STROKE_COLOR = '#1c1917';

/** CSS-pixel coordinates — must match ctx.setTransform(dpr) logical space */
function getLogicalPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function getDpr(): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio || 1, MAX_DPR);
}

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ onStroke }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const drawingRef = useRef(false);
    const hasContentRef = useRef(false);
    const cssSizeRef = useRef({ width: 320, height: CANVAS_HEIGHT_CSS });
    const modeRef = useRef<SignatureMode>('draw');
    const typedNameRef = useRef('');

    const [mode, setMode] = useState<SignatureMode>('draw');
    const [typedName, setTypedName] = useState('');

    modeRef.current = mode;
    typedNameRef.current = typedName;

    const markContent = useCallback(() => {
      hasContentRef.current = true;
      onStroke?.();
    }, [onStroke]);

    const clearCanvasBuffer = useCallback((ctx: CanvasRenderingContext2D) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }, []);

    const applyDrawStyles = useCallback((ctx: CanvasRenderingContext2D) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = STROKE_COLOR;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }, []);

    const renderTypedSignature = useCallback(
      async (text: string) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const { width, height } = cssSizeRef.current;
        const dpr = getDpr();
        const trimmed = text.trim();

        clearCanvasBuffer(ctx);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (!trimmed) {
          hasContentRef.current = false;
          return;
        }

        const fontFamily = signatureScript.style.fontFamily;
        const fontSize = Math.min(72, Math.max(36, width / Math.max(trimmed.length * 0.45, 6)));

        try {
          if (typeof document !== 'undefined' && document.fonts) {
            await document.fonts.load(`${fontSize}px ${fontFamily}`);
          }
        } catch {
          /* proceed with fallback if font load fails */
        }

        ctx.fillStyle = STROKE_COLOR;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.font = `${fontSize}px ${fontFamily}`;

        const metrics = ctx.measureText(trimmed);
        const textWidth = metrics.width;
        const scale =
          textWidth > width * 0.92 ? (width * 0.92) / textWidth : 1;
        if (scale < 1) {
          ctx.save();
          ctx.translate(width / 2, height / 2);
          ctx.scale(scale, scale);
          ctx.fillText(trimmed, 0, 4);
          ctx.restore();
        } else {
          ctx.fillText(trimmed, width / 2, height / 2 + 4);
        }

        hasContentRef.current = true;
      },
      [clearCanvasBuffer]
    );

    const setupCanvas = useCallback(
      (preserveDrawn = false) => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const width = container.clientWidth || 320;
        const height = CANVAS_HEIGHT_CSS;
        const dpr = getDpr();

        let preserveUrl: string | null = null;
        if (
          preserveDrawn &&
          hasContentRef.current &&
          modeRef.current === 'draw'
        ) {
          preserveUrl = canvas.toDataURL();
        }

        cssSizeRef.current = { width, height };

        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        applyDrawStyles(ctx);

        if (modeRef.current === 'type' && typedNameRef.current.trim()) {
          void renderTypedSignature(typedNameRef.current);
        } else if (preserveUrl) {
          const img = new Image();
          img.onload = () => {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.drawImage(img, 0, 0, width, height);
            applyDrawStyles(ctx);
          };
          img.src = preserveUrl;
        } else if (modeRef.current === 'draw' && !preserveDrawn) {
          clearCanvasBuffer(ctx);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          applyDrawStyles(ctx);
        }
      },
      [applyDrawStyles, clearCanvasBuffer, renderTypedSignature]
    );

    useEffect(() => {
      setupCanvas();
      const container = containerRef.current;
      if (!container) return;

      const observer = new ResizeObserver(() => {
        setupCanvas(true);
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [setupCanvas]);

    const clear = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return;
      clearCanvasBuffer(ctx);
      const dpr = getDpr();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      applyDrawStyles(ctx);
      hasContentRef.current = false;
      setTypedName('');
    }, [applyDrawStyles, clearCanvasBuffer]);

    useImperativeHandle(
      ref,
      () => ({
        clear,
        isEmpty: () => !hasContentRef.current,
        toDataURL: () => {
          if (!hasContentRef.current) return null;
          const canvas = canvasRef.current;
          if (!canvas) return null;
          return trimSignatureCanvasToDataUrl(canvas);
        },
      }),
      [clear]
    );

    const switchMode = (next: SignatureMode) => {
      if (next === mode) return;
      drawingRef.current = false;
      hasContentRef.current = false;
      setTypedName('');
      setMode(next);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        clearCanvasBuffer(ctx);
        const dpr = getDpr();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        applyDrawStyles(ctx);
      }
    };

    const handleTypedChange = (value: string) => {
      setTypedName(value);
      void renderTypedSignature(value).then(() => {
        if (value.trim()) markContent();
        else hasContentRef.current = false;
      });
    };

    const startDraw = (x: number, y: number) => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      drawingRef.current = true;
      ctx.beginPath();
      ctx.moveTo(x, y);
    };

    const draw = (x: number, y: number) => {
      if (!drawingRef.current) return;
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.lineTo(x, y);
      ctx.stroke();
      markContent();
    };

    const endDraw = () => {
      drawingRef.current = false;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode !== 'draw') return;
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      const { x, y } = getLogicalPoint(canvas, e.clientX, e.clientY);
      startDraw(x, y);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode !== 'draw' || !drawingRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y } = getLogicalPoint(canvas, e.clientX, e.clientY);
      draw(x, y);
    };

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode !== 'draw') return;
      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      endDraw();
    };

    return (
      <div className="space-y-3">
        <div
          className="inline-flex rounded-md border border-stone-200 bg-stone-50 p-0.5"
          role="tablist"
          aria-label="Signature method"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'draw'}
            onClick={() => switchMode('draw')}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'draw'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Draw
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'type'}
            onClick={() => switchMode('type')}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'type'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Type name
          </button>
        </div>

        {mode === 'type' && (
          <label className="block">
            <span className="sr-only">Type your full name for signature</span>
            <input
              type="text"
              value={typedName}
              onChange={(e) => handleTypedChange(e.target.value)}
              placeholder="Type your full name"
              autoComplete="name"
              className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-base text-stone-900 outline-none ring-stone-300 placeholder:text-stone-400 focus:ring-2"
              aria-label="Type your signature"
            />
          </label>
        )}

        <div
          ref={containerRef}
          className="overflow-hidden rounded-md border border-stone-200 bg-white"
        >
          <canvas
            ref={canvasRef}
            className={`block w-full touch-none ${
              mode === 'draw' ? 'cursor-crosshair' : 'cursor-default'
            }`}
            aria-label={
              mode === 'draw'
                ? 'Draw your signature'
                : 'Preview of your typed signature'
            }
            style={{ height: CANVAS_HEIGHT_CSS }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        <p className="text-xs text-stone-500">
          {mode === 'draw'
            ? 'Sign with your finger, stylus, or mouse in the box above.'
            : 'Your name appears in script above — same as signing on paper.'}
        </p>
      </div>
    );
  }
);

export default SignaturePad;
