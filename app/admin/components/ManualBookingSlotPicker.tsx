'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import {
  formatSlotInStudioTime,
  parseCalSlotTimes,
  STUDIO_TIMEZONE,
  todayInStudio,
} from './manual-booking-utils';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function parseStudioDate(isoDate: string): { year: number; month: number; day: number } {
  const [y, m, d] = isoDate.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function studioDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 15)));
}

function buildMonthCells(year: number, month: number): Array<{ date: string; day: number } | null> {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<{ date: string; day: number } | null> = [];

  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: studioDateString(year, month, day), day });
  }
  return cells;
}

interface Props {
  eventTypeId: number;
  clientName: string;
  selectedSlot: string | null;
  onSelectSlot: (isoUtc: string | null) => void;
}

export default function ManualBookingSlotPicker({
  eventTypeId,
  clientName,
  selectedSlot,
  onSelectSlot,
}: Props) {
  const today = todayInStudio();
  const initial = parseStudioDate(today);

  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);
  const [selectedDate, setSelectedDate] = useState(today);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const monthCells = useMemo(
    () => buildMonthCells(viewYear, viewMonth),
    [viewYear, viewMonth]
  );

  const loadSlots = useCallback(
    async (day: string) => {
      setSlotsLoading(true);
      setSlotsError(null);
      setSlots([]);
      onSelectSlot(null);

      try {
        const params = new URLSearchParams({
          eventTypeId: String(eventTypeId),
          date: day,
        });
        const res = await fetch(`/api/admin/manual-booking/slots?${params}`);
        const data: unknown = await res.json().catch(() => null);

        if (!res.ok) {
          const message =
            data &&
            typeof data === 'object' &&
            'message' in data &&
            typeof (data as { message: unknown }).message === 'string'
              ? (data as { message: string }).message
              : `Could not load times (HTTP ${res.status})`;
          setSlotsError(message);
          return;
        }

        const times = parseCalSlotTimes(data, day);
        setSlots(times);
        if (times.length === 0) {
          setSlotsError('No open times on this day. Try another date.');
        }
      } catch (err) {
        setSlotsError(
          err instanceof Error ? err.message : 'Failed to load available times'
        );
      } finally {
        setSlotsLoading(false);
      }
    },
    [eventTypeId, onSelectSlot]
  );

  useEffect(() => {
    void loadSlots(selectedDate);
  }, [selectedDate, loadSlots]);

  function shiftMonth(delta: number) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  }

  function pickDate(date: string) {
    if (date < today) return;
    setSelectedDate(date);
    const { year, month } = parseStudioDate(date);
    setViewYear(year);
    setViewMonth(month);
  }

  const selectedDayLabel = (() => {
    try {
      const [y, m, d] = selectedDate.split('-').map(Number);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: STUDIO_TIMEZONE,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }).format(new Date(Date.UTC(y, m - 1, d, 12)));
    } catch {
      return selectedDate;
    }
  })();

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600">
        <span className="font-medium text-stone-900">{clientName}</span>
        <span className="text-stone-400"> · details already saved</span>
      </p>

      <div className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="font-medium text-stone-900">{monthLabel(viewYear, viewMonth)}</p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-stone-400">
          {WEEKDAYS.map((d) => (
            <span key={d} className="py-1">
              {d}
            </span>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {monthCells.map((cell, idx) => {
            if (!cell) {
              return <span key={`pad-${idx}`} aria-hidden />;
            }
            const isPast = cell.date < today;
            const isSelected = cell.date === selectedDate;
            return (
              <button
                key={cell.date}
                type="button"
                disabled={isPast}
                onClick={() => pickDate(cell.date)}
                className={`flex h-9 w-full items-center justify-center rounded-full text-sm transition-colors ${
                  isSelected
                    ? 'bg-stone-900 font-semibold text-stone-50'
                    : isPast
                      ? 'cursor-not-allowed text-stone-300'
                      : 'text-stone-800 hover:bg-stone-100'
                }`}
              >
                {cell.day}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-stone-900">{selectedDayLabel}</p>
          <p className="text-[10px] uppercase tracking-[0.2em] text-stone-400">
            Mountain time
          </p>
        </div>

        {slotsLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading times…
          </div>
        ) : slots.length > 0 ? (
          <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-3">
            {slots.map((slot) => {
              const active = selectedSlot === slot;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => onSelectSlot(slot)}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-sm transition-colors ${
                    active
                      ? 'border-stone-900 bg-stone-900 text-stone-50'
                      : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-400 hover:bg-white'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      active ? 'bg-emerald-300' : 'bg-emerald-500'
                    }`}
                    aria-hidden
                  />
                  {formatSlotInStudioTime(slot)}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-stone-500">
            {slotsError ?? 'No times to show.'}
          </p>
        )}

        {slotsError && slots.length > 0 && (
          <p className="mt-2 text-center text-xs text-amber-700">{slotsError}</p>
        )}
      </div>
    </div>
  );
}
