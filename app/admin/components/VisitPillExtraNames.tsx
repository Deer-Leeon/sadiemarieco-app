'use client';

import type { Appointment } from '../types';
import { appointmentServiceLabel } from '../helpers';

/** Extra service titles sit under the main pill copy. */
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

  return (
    <>
      {extras.map((extra) => (
        <div
          key={extra.id}
          className={`mt-0.5 truncate font-semibold leading-tight ${
            compact ? 'text-[9px]' : 'text-[10px]'
          }`}
        >
          + {appointmentServiceLabel(extra)}
        </div>
      ))}
    </>
  );
}
