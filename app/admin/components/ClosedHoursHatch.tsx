'use client';

const HATCH_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(231, 229, 228, 0.55)',
  backgroundImage:
    'repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(168, 162, 158, 0.28) 5px, rgba(168, 162, 158, 0.28) 6px)',
};

/**
 * Quiet diagonal wash for official closed hours on the admin time grid.
 * Distinct from TimeBlockPill's denser stripe — this is background, not a hold.
 */
export default function ClosedHoursHatch({
  bands,
}: {
  bands: { topPct: number; heightPct: number }[];
}) {
  if (bands.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      {bands.map((band, index) => (
        <div
          key={`${band.topPct}-${band.heightPct}-${index}`}
          className="absolute left-0 right-0"
          style={{
            top: `${band.topPct}%`,
            height: `${band.heightPct}%`,
            ...HATCH_STYLE,
          }}
        />
      ))}
    </div>
  );
}
