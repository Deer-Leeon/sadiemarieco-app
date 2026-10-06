'use client';

import {
  customTipMaxCents,
  CUSTOM_TIP_MIN_CENTS,
  parseTipDollars,
  resolveTipCents,
  type TipPreset,
} from '@/lib/booking-tip';

const QUICK_CHOICES: { preset: TipPreset; label: string }[] = [
  { preset: 'none', label: 'No tip' },
  { preset: '10', label: '10%' },
  { preset: '15', label: '15%' },
  { preset: '20', label: '20%' },
];

function tipChoiceClass(selected: boolean): string {
  return `flex min-h-12 flex-col items-center justify-center rounded-full border px-3 py-2 text-center transition-colors ${
    selected
      ? 'border-stone-900 bg-stone-900 text-white'
      : 'border-stone-200 bg-white text-stone-800 hover:border-stone-400'
  }`;
}

export function formatTipUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function TipPicker({
  serviceCents,
  preset,
  customInput,
  onPreset,
  onCustomInput,
  compact = false,
}: {
  serviceCents: number;
  preset: TipPreset;
  customInput: string;
  onPreset: (preset: TipPreset) => void;
  onCustomInput: (value: string) => void;
  compact?: boolean;
}) {
  const customCents = parseTipDollars(customInput);
  const resolved =
    preset === 'custom'
      ? resolveTipCents(serviceCents, 'custom', customCents)
      : resolveTipCents(serviceCents, preset);
  const maxCents = customTipMaxCents(serviceCents);

  const customSelected = preset === 'custom';

  return (
    <fieldset className={`min-w-0 border-0 p-0 ${compact ? 'mt-5' : 'mt-6'}`}>
      <legend className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
        Add a tip
      </legend>
      <p className="mt-1.5 text-xs leading-relaxed text-stone-500">
        Optional. The tip is separate from the service price.
      </p>
      <div className="mt-3.5 grid grid-cols-2 gap-2">
        {QUICK_CHOICES.map((choice) => {
          const selected = preset === choice.preset;
          const amount =
            choice.preset === '10' || choice.preset === '15' || choice.preset === '20'
              ? resolveTipCents(serviceCents, choice.preset)
              : null;
          return (
            <button
              key={choice.preset}
              type="button"
              aria-pressed={selected}
              onClick={() => onPreset(choice.preset)}
              className={tipChoiceClass(selected)}
            >
              <span className="text-sm font-medium leading-none">{choice.label}</span>
              {amount && amount.ok && amount.tipCents > 0 ? (
                <span
                  className={`mt-1 text-[11px] tabular-nums leading-none ${
                    selected ? 'text-stone-300' : 'text-stone-500'
                  }`}
                >
                  {formatTipUsd(amount.tipCents)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-pressed={customSelected}
        onClick={() => onPreset('custom')}
        className={`${tipChoiceClass(customSelected)} mt-2 w-full`}
      >
        <span className="text-sm font-medium leading-none">Custom</span>
      </button>
      {preset === 'custom' ? (
        <label className="mt-2.5 block">
          <span className="sr-only">Custom tip amount</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={customInput}
            onChange={(event) => onCustomInput(event.target.value)}
            className="w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-400"
          />
          {customInput.trim() && !resolved.ok ? (
            <p className="mt-1.5 text-xs text-rose-700" role="alert">
              Enter a tip from {formatTipUsd(CUSTOM_TIP_MIN_CENTS)} to{' '}
              {formatTipUsd(maxCents)}.
            </p>
          ) : null}
        </label>
      ) : null}
    </fieldset>
  );
}

export function PayNowLines({
  serviceCents,
  tipCents,
  compact = false,
}: {
  serviceCents: number;
  tipCents: number;
  compact?: boolean;
}) {
  const row = compact ? 'text-sm' : 'text-sm';
  return (
    <div className={compact ? 'mt-3 space-y-1.5 border-b border-stone-100 pb-3' : 'mt-6 space-y-2 border-b border-stone-100 pb-4'}>
      <div className={`flex items-baseline justify-between text-stone-500 ${row}`}>
        <span>Service</span>
        <span>{formatTipUsd(serviceCents)}</span>
      </div>
      <div className={`flex items-baseline justify-between text-stone-500 ${row}`}>
        <span>Tip</span>
        <span>{formatTipUsd(tipCents)}</span>
      </div>
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500">
          Due today
        </p>
        <p className={compact ? 'font-serif text-xl text-stone-900' : 'font-serif text-2xl text-stone-900'}>
          {formatTipUsd(serviceCents + tipCents)}
        </p>
      </div>
    </div>
  );
}
