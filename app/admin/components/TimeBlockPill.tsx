'use client';

import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';

import { MIN_PILL_HEIGHT_PX, safeParseISO } from '../timeline';
import type { TimeBlock } from '../types';

export const TIME_BLOCK_PILL_CLASS =
  'overflow-hidden rounded-sm border border-stone-300 bg-[repeating-linear-gradient(-45deg,#e7e5e4,#e7e5e4_6px,#d6d3d1_6px,#d6d3d1_12px)] text-left shadow-sm transition-opacity hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-stone-900/30 disabled:opacity-60';

interface Props {
  block: TimeBlock;
  topPct: number;
  heightPct: number;
  removing?: boolean;
  compact?: boolean;
  /** Roomier typography + padding for the single-day modal. */
  spacious?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}

export function timeBlockTimeLabel(block: TimeBlock): string {
  const start = safeParseISO(block.start_time);
  const end = safeParseISO(block.end_time);
  if (start && end) {
    return `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`;
  }
  return 'Blocked';
}

export default function TimeBlockPill({
  block,
  topPct,
  heightPct,
  removing = false,
  compact = false,
  spacious = false,
  className = '',
  style,
  onClick,
}: Props) {
  const timeLabel = timeBlockTimeLabel(block);
  const title = `${timeLabel}${block.note ? ` — ${block.note}` : ''} (click to remove)`;
  const shortBlock = heightPct < 6;

  const paddingClass = spacious ? 'px-3 py-2' : compact ? 'p-1.5' : 'p-2';
  const titleClass = spacious
    ? 'text-sm font-semibold tracking-wide'
    : compact
      ? 'text-xs font-medium'
      : 'text-sm font-medium';
  const metaClass = spacious
    ? 'text-xs text-stone-600'
    : compact
      ? 'text-[10px] text-stone-600'
      : 'text-[11px] text-stone-600';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      disabled={removing || !onClick}
      className={`absolute z-10 ${TIME_BLOCK_PILL_CLASS} ${paddingClass} ${className} ${
        spacious ? 'flex flex-col justify-center' : ''
      }`}
      title={title}
      aria-label={`Blocked time ${timeLabel}. Click to remove.`}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        minHeight: shortBlock ? MIN_PILL_HEIGHT_PX : spacious ? 40 : MIN_PILL_HEIGHT_PX,
        ...style,
      }}
    >
      <div className={`flex items-center gap-1.5 truncate text-stone-700 ${titleClass}`}>
        {removing && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
        {shortBlock && !spacious ? (
          <span className="truncate">
            Blocked · {timeLabel}
          </span>
        ) : (
          <span>Blocked</span>
        )}
      </div>
      {!shortBlock && (
        <div className={`${spacious ? 'mt-1' : 'mt-0.5'} truncate ${metaClass}`}>
          {timeLabel}
          {block.note ? ` · ${block.note}` : ''}
        </div>
      )}
    </button>
  );
}
