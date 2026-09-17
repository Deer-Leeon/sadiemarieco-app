'use client';

import type { Appointment } from '../types';
import { appointmentServiceLabel } from '../helpers';
import { visitPaintBands } from '../serviceColors';

/** Extra service titles sit in their colour band on a visit pill. */
export function VisitPillExtraNames({
  appointment,
  enabled,
  compact = false,
}: {
  appointment: Appointment;
  enabled: boolean;
  compact?: boolean;
}) {
  if (!enabled) return null;
  const extras = appointment.extras ?? [];
  if (extras.length === 0) return null;
  const extraBands = visitPaintBands(appointment).filter((band) => band.kind === 'extra');
  const minSpan = compact ? 18 : 12;

  return (
    <>
      {extras.map((extra, index) => {
        const band = extraBands[index];
        if (!band) return null;
        if (band.endPct - band.startPct < minSpan) return null;
        return (
          <span
            key={extra.id}
            className={`pointer-events-none absolute left-1.5 right-5 z-[1] truncate font-semibold leading-tight ${
              compact ? 'text-[9px]' : 'text-[10px]'
            }`}
            style={{
              top: `calc(${band.startPct}% + 3px)`,
              color: band.text,
            }}
          >
            {appointmentServiceLabel(extra)}
          </span>
        );
      })}
    </>
  );
}
