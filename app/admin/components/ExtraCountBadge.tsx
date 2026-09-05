import { extraDuringVisitLabel } from '@/lib/appointment-extras';

export function ExtraCountBadge({
  count,
  size = 'sm',
}: {
  count: number | null | undefined;
  size?: 'sm' | 'md';
}) {
  if (!count || count <= 0) return null;
  const label = extraDuringVisitLabel(count);
  const box =
    size === 'md'
      ? 'h-4 min-w-4 px-0.5 text-[9px]'
      : 'h-3.5 min-w-3.5 px-0.5 text-[8px]';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-sm bg-white/95 font-semibold tabular-nums text-stone-800 shadow-sm ${box}`}
      title={label}
      aria-label={label}
    >
      +{count}
    </span>
  );
}
