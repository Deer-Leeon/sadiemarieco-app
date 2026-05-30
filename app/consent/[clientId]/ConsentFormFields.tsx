'use client';

import type { YesNo } from './consent-form-config';

export const inputClass =
  'mt-1 w-full rounded-md border border-stone-200 bg-[#FAF9F6] px-3 py-2 text-sm text-stone-900 outline-none ring-stone-300 focus:ring-2';

export const sectionClass =
  'overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm';

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
  return <div className="space-y-4 p-5">{children}</div>;
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
      <div className="flex flex-wrap gap-4">
        {(['yes', 'no'] as const).map((option) => (
          <label
            key={option}
            className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-800"
          >
            <input
              type="radio"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-4 w-4 border-stone-300 text-stone-900 focus:ring-stone-400"
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
