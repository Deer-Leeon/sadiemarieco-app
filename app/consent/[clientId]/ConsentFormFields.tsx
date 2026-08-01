'use client';

import type { YesNo } from './consent-form-config';

export const inputClass =
  'mt-1 box-border block w-full min-w-0 max-w-full rounded-md border border-stone-200 bg-[#FAF9F6] px-3 py-2 text-sm text-stone-900 outline-none ring-stone-300 focus:ring-2';

/** Native date controls on iOS ignore width unless min-width is forced down. */
export const dateInputClass = `${inputClass} appearance-none [-webkit-appearance:none]`;

export const selectClass =
  `${inputClass} appearance-none bg-size-[14px_14px] bg-position-[right_0.75rem_center] bg-no-repeat pr-9 bg-[url("data:image/svg+xml;utf8,<svg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2020%2020'%20fill='%2378716c'><path%20d='M5.516%207.548L10%2012.032l4.484-4.484L16%209.064l-6%206-6-6z'/></svg>")]`;

export const sectionClass =
  'overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm';

export const checkboxClass =
  'h-5 w-5 shrink-0 rounded border-stone-300 text-stone-900 accent-stone-900 focus:ring-2 focus:ring-stone-400 focus:ring-offset-0 touch-manipulation';

export const checkboxRowClass =
  'flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-1 py-2.5 text-sm text-stone-800 touch-manipulation active:bg-stone-100/80';

export function SectionHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-stone-200 bg-stone-100/90 px-4 py-2.5">
      <h2 className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
        {title}
      </h2>
    </div>
  );
}

export function SectionBody({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 overflow-x-hidden p-5">{children}</div>;
}

export function RequiredMark() {
  return (
    <span className="ml-0.5 text-red-600" aria-hidden>
      *
    </span>
  );
}

export function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <span className="text-xs font-medium text-stone-700">
      {children}
      {required ? <RequiredMark /> : null}
    </span>
  );
}

export function YesNoQuestion({
  name,
  label,
  value,
  onChange,
  required,
  children,
}: {
  name: string;
  label: string;
  value: YesNo;
  onChange: (v: YesNo) => void;
  required?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-b border-dotted border-stone-200 pb-4 last:border-b-0 last:pb-0">
      <p className="text-sm leading-snug text-stone-800">
        {label}
        {required ? <RequiredMark /> : null}
      </p>
      <div className="flex flex-wrap gap-3">
        {(['yes', 'no'] as const).map((option) => (
          <label
            key={option}
            className="inline-flex min-h-11 min-w-22 cursor-pointer items-center gap-2.5 rounded-md border border-stone-200 bg-[#FAF9F6] px-3 py-2 text-sm text-stone-800 touch-manipulation active:bg-stone-100"
          >
            <input
              type="radio"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-5 w-5 shrink-0 border-stone-300 text-stone-900 accent-stone-900 focus:ring-2 focus:ring-stone-400 touch-manipulation"
            />
            <span className="capitalize">{option}</span>
          </label>
        ))}
      </div>
      {children}
    </div>
  );
}

export function formatYesNo(value: unknown): string {
  if (value === 'yes') return 'Yes';
  if (value === 'no') return 'No';
  return '—';
}
