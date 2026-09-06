'use client';

import {
  HOURS,
  HOUR_AXIS_END_LABEL,
  HOUR_AXIS_START_LABELS,
  HOUR_END_CAPTION_PX,
} from '../timeline';

/**
 * 9 AM → 9 PM rules (13 lines). Drawn as real 1px bars above the closed-hours
 * hatch so they stay visible on striped days.
 */
export function HourRules() {
  return (
    <div className="pointer-events-none absolute inset-0 z-5" aria-hidden="true">
      {Array.from({ length: HOURS + 1 }, (_, i) => (
        <div
          key={i}
          className="absolute inset-x-0 h-px bg-stone-400"
          style={
            i === HOURS
              ? { bottom: 0 }
              : { top: `${(i / HOURS) * 100}%` }
          }
        />
      ))}
    </div>
  );
}

/**
 * Hour ticks for 3-day / week / day-modal grids. 9 AM sits on the first
 * rule; 9 PM sits in a reserved caption so it cannot be clipped.
 */
export default function HourAxisColumn({
  labelClassName,
}: {
  labelClassName: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-stone-200">
      <div className="relative min-h-0 flex-1">
        {HOUR_AXIS_START_LABELS.map((label, i) => (
          <span
            key={label}
            className={`absolute right-0 ${labelClassName}`}
            style={{ top: `${(i / HOURS) * 100}%` }}
          >
            {label}
          </span>
        ))}
      </div>
      <div
        className="relative shrink-0"
        style={{ height: HOUR_END_CAPTION_PX }}
      >
        <span className={`absolute right-0 top-0 ${labelClassName}`}>
          {HOUR_AXIS_END_LABEL}
        </span>
      </div>
    </div>
  );
}
