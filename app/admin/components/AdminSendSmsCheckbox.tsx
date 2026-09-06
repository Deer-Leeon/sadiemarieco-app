'use client';

import { Check } from 'lucide-react';

export default function AdminSendSmsCheckbox({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      } ${className ?? ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-stone-300 bg-white transition-colors peer-checked:border-stone-900 peer-checked:bg-stone-900 peer-focus-visible:ring-2 peer-focus-visible:ring-stone-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#FAF9F6]"
        aria-hidden
      >
        <Check
          className={`h-3 w-3 text-white ${checked ? 'opacity-100' : 'opacity-0'}`}
          strokeWidth={3}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-stone-900">
          Text the client
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
          Uncheck to cancel/move this booking without a studio text.
        </span>
      </span>
    </label>
  );
}
