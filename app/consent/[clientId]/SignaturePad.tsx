'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';

export type SignaturePadHandle = {
  clear: () => void;
  isEmpty: () => boolean;
  toDataURL: () => string | null;
};

type SignaturePadProps = {
  onStroke?: () => void;
};

function getPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ onStroke }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef(false);
    const hasStrokeRef = useRef(false);

    const resizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      const width = parent?.clientWidth ?? 320;
      const height = 160;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1c1917';
    }, []);

    useEffect(() => {
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);
      return () => window.removeEventListener('resize', resizeCanvas);
    }, [resizeCanvas]);

    const clear = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasStrokeRef.current = false;
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        clear,
        isEmpty: () => !hasStrokeRef.current,
        toDataURL: () => {
          if (!hasStrokeRef.current) return null;
          const canvas = canvasRef.current;
          if (!canvas) return null;
          return canvas.toDataURL('image/png');
        },
      }),
      [clear]
    );

    const startDraw = (x: number, y: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;
      drawingRef.current = true;
      ctx.beginPath();
      ctx.moveTo(x, y);
    };

    const draw = (x: number, y: number) => {
      if (!drawingRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;
      ctx.lineTo(x, y);
      ctx.stroke();
      hasStrokeRef.current = true;
      onStroke?.();
    };

    const endDraw = () => {
      drawingRef.current = false;
    };

    return (
      <div className="space-y-2">
        <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
          <canvas
            ref={canvasRef}
            className="block touch-none cursor-crosshair"
            aria-label="Draw your signature"
            onMouseDown={(e) => {
              e.preventDefault();
              const canvas = canvasRef.current;
              if (!canvas) return;
              const { x, y } = getPoint(
                canvas,
                e.nativeEvent.clientX,
                e.nativeEvent.clientY
              );
              startDraw(x, y);
            }}
            onMouseMove={(e) => {
              const canvas = canvasRef.current;
              if (!canvas || !drawingRef.current) return;
              const { x, y } = getPoint(
                canvas,
                e.nativeEvent.clientX,
                e.nativeEvent.clientY
              );
              draw(x, y);
            }}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            onTouchStart={(e) => {
              e.preventDefault();
              const canvas = canvasRef.current;
              if (!canvas || e.touches.length !== 1) return;
              const touch = e.touches[0];
              const { x, y } = getPoint(canvas, touch.clientX, touch.clientY);
              startDraw(x, y);
            }}
            onTouchMove={(e) => {
              e.preventDefault();
              const canvas = canvasRef.current;
              if (!canvas || !drawingRef.current || e.touches.length !== 1) return;
              const touch = e.touches[0];
              const { x, y } = getPoint(canvas, touch.clientX, touch.clientY);
              draw(x, y);
            }}
            onTouchEnd={endDraw}
          />
        </div>
        <p className="text-xs text-stone-500">
          Sign with your finger or mouse in the box above.
        </p>
      </div>
    );
  }
);

export default SignaturePad;
