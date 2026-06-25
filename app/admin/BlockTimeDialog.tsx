'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Loader2, X } from 'lucide-react';

import { END_HOUR, START_HOUR } from './timeline';

interface Props {
  activeDate: Date;
  /** When set, pre-fills start time to this hour (local). */
  initialHour?: number;
  onClose: () => void;
  onCreated?: (infoMessage?: string) => void;
}

function dateAtHour(base: Date, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function toTimeInputValue(d: Date): string {
  return format(d, 'HH:mm');
}

function applyTimeInput(base: Date, value: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return dateAtHour(base, hour, minute);
}

export default function BlockTimeDialog({
  activeDate,
  initialHour = START_HOUR,
  onClose,
  onCreated,
}: Props) {
  const defaultStart = useMemo(
    () => dateAtHour(activeDate, initialHour),
    [activeDate, initialHour]
  );
  const defaultEnd = useMemo(() => {
    const end = new Date(defaultStart);
    end.setHours(end.getHours() + 1);
    if (end.getHours() > END_HOUR || (end.getHours() === END_HOUR && end.getMinutes() > 0)) {
      return dateAtHour(activeDate, END_HOUR);
    }
    return end;
  }, [activeDate, defaultStart]);

  const [startValue, setStartValue] = useState(() => toTimeInputValue(defaultStart));
  const [endValue, setEndValue] = useState(() => toTimeInputValue(defaultEnd));
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartValue(toTimeInputValue(defaultStart));
    setEndValue(toTimeInputValue(defaultEnd));
    setError(null);
  }, [defaultStart, defaultEnd]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const start = applyTimeInput(activeDate, startValue);
    const end = applyTimeInput(activeDate, endValue);
    if (!start || !end) {
      setError('Enter valid start and end times.');
      return;
    }
    if (start.getHours() < START_HOUR || end.getHours() > END_HOUR || (end.getHours() === END_HOUR && end.getMinutes() > 0)) {
      setError(`Blocks must stay within ${START_HOUR}:00 AM – ${END_HOUR > 12 ? END_HOUR - 12 : END_HOUR}:00 PM.`);
      return;
    }
    if (end <= start) {
      setError('End time must be after start time.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/time-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: start.toISOString(),
          end: end.toISOString(),
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.message === 'string'
            ? data.message
            : 'Could not create time block.'
        );
        return;
      }
      onCreated?.(
        typeof data.message === 'string' && data.message.trim()
          ? data.message
          : undefined
      );
      onClose();
    } catch {
      setError('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[#FAF9F6] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Block time"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              Block time
            </p>
            <h3 className="font-serif text-xl text-stone-900">
              {format(activeDate, 'EEEE, MMMM d')}
            </h3>
            <p className="mt-1 text-sm text-stone-600">
              Clients won&apos;t be able to book into this interval on the website.
              Any length works — we combine Cal slots automatically (30&nbsp;min minimum).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
                Start
              </span>
              <input
                type="time"
                value={startValue}
                onChange={(e) => setStartValue(e.target.value)}
                className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
                End
              </span>
              <input
                type="time"
                value={endValue}
                onChange={(e) => setEndValue(e.target.value)}
                className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
                required
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
              Note <span className="normal-case tracking-normal text-stone-400">(optional)</span>
            </span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Lunch, personal errand"
              maxLength={500}
              className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-stone-50 hover:bg-stone-800 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Block time
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
