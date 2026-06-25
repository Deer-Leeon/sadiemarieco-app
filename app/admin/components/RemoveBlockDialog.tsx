'use client';

import { useEffect } from 'react';
import { CalendarOff, Loader2 } from 'lucide-react';

import { timeBlockTimeLabel } from './TimeBlockPill';
import type { TimeBlock } from '../types';

interface Props {
  block: TimeBlock;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function RemoveBlockDialog({
  block,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const timeLabel = timeBlockTimeLabel(block);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={busy ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-block-title"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-200/80 bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-6 pt-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-200 text-stone-700">
            <CalendarOff className="h-5 w-5" strokeWidth={1.6} />
          </span>
          <div className="flex-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              Remove block
            </p>
            <h3
              id="remove-block-title"
              className="font-serif text-xl leading-tight text-stone-900"
            >
              Unblock this time?
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              <span className="font-medium text-stone-800">{timeLabel}</span>
              {block.note ? (
                <>
                  {' '}
                  <span className="text-stone-500">({block.note})</span>
                </>
              ) : null}{' '}
              will be bookable again on the website.
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-stone-200/70 bg-stone-100/40 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            Keep blocked
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-stone-50 transition-colors hover:bg-stone-800 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Remove block
          </button>
        </div>
      </div>
    </div>
  );
}
