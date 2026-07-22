'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import {
  isSlotStartInStudioWindows,
  studioDaysInRange,
  studioWindowsForDate,
  type StudioAvailabilityBlock,
  type StudioDateOverride,
  type StudioTimeWindow,
} from '@/lib/studio-schedule-windows';

import {
  filterSlotsForBookingDay,
  formatSlotInStudioTime,
  isStudioDateInMonth,
  slotsGroupedByStudioDate,
  slotToStudioLocalHhmm,
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

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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
  const daysInMonth = lastDayOfMonth(year, month);
  const cells: Array<{ date: string; day: number } | null> = [];

  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: studioDateString(year, month, day), day });
  }
  return cells;
}

function parseSchedulePayload(data: unknown): {
  availability: StudioAvailabilityBlock[];
  overrides: StudioDateOverride[];
} | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.availability) || !Array.isArray(root.overrides)) {
    return null;
  }
  return {
    availability: root.availability as StudioAvailabilityBlock[],
    overrides: root.overrides as StudioDateOverride[],
  };
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
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [monthSlots, setMonthSlots] = useState<Record<string, string[]>>({});
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [studioDaySet, setStudioDaySet] = useState<Set<string>>(() => new Set());
  const [scheduleAvailability, setScheduleAvailability] = useState<
    StudioAvailabilityBlock[]
  >([]);
  const [scheduleOverrides, setScheduleOverrides] = useState<StudioDateOverride[]>(
    []
  );
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthError, setMonthError] = useState<string | null>(null);
  /** Skip empty current month once on open so admins land on the next bookable month. */
  const mayAdvanceFromEmptyStart = useRef(true);

  const availableSet = useMemo(() => new Set(availableDates), [availableDates]);

  const monthCells = useMemo(
    () => buildMonthCells(viewYear, viewMonth),
    [viewYear, viewMonth]
  );

  const selectedDayWindows: StudioTimeWindow[] = useMemo(() => {
    if (!selectedDate) return [];
    return studioWindowsForDate(
      selectedDate,
      scheduleAvailability,
      scheduleOverrides
    );
  }, [selectedDate, scheduleAvailability, scheduleOverrides]);

  const loadMonth = useCallback(
    async (year: number, month: number) => {
      setMonthLoading(true);
      setMonthError(null);
      setMonthSlots({});
      setAvailableDates([]);
      setStudioDaySet(new Set());
      setSelectedDate(null);
      onSelectSlot(null);

      const rangeStart = studioDateString(year, month, 1);
      const rangeEnd = studioDateString(year, month, lastDayOfMonth(year, month));
      const queryStart = rangeStart < today ? today : rangeStart;

      if (queryStart > rangeEnd) {
        setSelectedDate(null);
        setMonthLoading(false);
        setMonthError('No open days left this month.');
        return;
      }

      try {
        const params = new URLSearchParams({
          eventTypeId: String(eventTypeId),
          date: queryStart,
          end: rangeEnd,
        });

        const [slotsRes, scheduleRes] = await Promise.all([
          fetch(`/api/admin/manual-booking/slots?${params}`),
          fetch('/api/admin/availability'),
        ]);

        const slotsData: unknown = await slotsRes.json().catch(() => null);
        const scheduleData: unknown = await scheduleRes.json().catch(() => null);

        const schedule = scheduleRes.ok ? parseSchedulePayload(scheduleData) : null;
        if (schedule) {
          setScheduleAvailability(schedule.availability);
          setScheduleOverrides(schedule.overrides);
          setStudioDaySet(
            studioDaysInRange(
              rangeStart,
              rangeEnd,
              schedule.availability,
              schedule.overrides
            )
          );
        } else {
          setScheduleAvailability([]);
          setScheduleOverrides([]);
          setStudioDaySet(new Set());
        }

        if (!slotsRes.ok) {
          const message =
            slotsData &&
            typeof slotsData === 'object' &&
            'message' in slotsData &&
            typeof (slotsData as { message: unknown }).message === 'string'
              ? (slotsData as { message: string }).message
              : `Could not load availability (HTTP ${slotsRes.status})`;
          setSelectedDate(null);
          setMonthError(message);
          return;
        }

        const grouped = slotsGroupedByStudioDate(slotsData, {
          rangeStart: queryStart,
          rangeEnd: rangeEnd,
        });

        const slotsByDay: Record<string, string[]> = {};

        for (const [date, times] of Object.entries(grouped)) {
          if (!isStudioDateInMonth(date, year, month)) continue;
          const filtered = filterSlotsForBookingDay(times, date, today);
          if (filtered.length > 0) {
            slotsByDay[date] = filtered;
          }
        }

        const openDates = Object.keys(slotsByDay).sort();

        setMonthSlots(slotsByDay);
        setAvailableDates(openDates);

        if (openDates.length === 0) {
          setSelectedDate(null);
          if (
            mayAdvanceFromEmptyStart.current &&
            year === initial.year &&
            month === initial.month
          ) {
            mayAdvanceFromEmptyStart.current = false;
            let nextMonth = month + 1;
            let nextYear = year;
            if (nextMonth > 12) {
              nextMonth = 1;
              nextYear += 1;
            }
            setViewYear(nextYear);
            setViewMonth(nextMonth);
            return;
          }
          setMonthError(`No open days in ${monthLabel(year, month)}. Try another month.`);
          return;
        }

        mayAdvanceFromEmptyStart.current = false;

        const defaultDate =
          openDates.includes(today) && isStudioDateInMonth(today, year, month)
            ? today
            : openDates[0];
        setSelectedDate(defaultDate);
      } catch (err) {
        setSelectedDate(null);
        setMonthError(
          err instanceof Error ? err.message : 'Failed to load availability'
        );
      } finally {
        setMonthLoading(false);
      }
    },
    [eventTypeId, onSelectSlot, today]
  );

  useEffect(() => {
    void loadMonth(viewYear, viewMonth);
  }, [viewYear, viewMonth, loadMonth]);

  const slots =
    selectedDate && selectedDate >= today
      ? filterSlotsForBookingDay(monthSlots[selectedDate] ?? [], selectedDate, today)
      : [];
  const slotsLoading = monthLoading;

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
    onSelectSlot(null);
  }

  const selectedDayLabel = (() => {
    if (!selectedDate || selectedDate < today) {
      return 'Select a day';
    }
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
            disabled={monthLoading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 disabled:opacity-40"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="font-medium text-stone-900">{monthLabel(viewYear, viewMonth)}</p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            disabled={monthLoading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 disabled:opacity-40"
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

        {monthLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading open days…
          </div>
        ) : (
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthCells.map((cell, idx) => {
              if (!cell) {
                return <span key={`pad-${idx}`} aria-hidden />;
              }
              const isPast = cell.date < today;
              const isSelectable = !isPast;
              const isStudio = studioDaySet.has(cell.date);
              const hasSlots = availableSet.has(cell.date);
              const isSelected =
                selectedDate !== null &&
                cell.date === selectedDate &&
                isSelectable;

              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={!isSelectable}
                  onClick={() => pickDate(cell.date)}
                  className={`flex h-9 w-full items-center justify-center rounded-full border text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 ${
                    isSelected
                      ? `${isStudio ? 'border-stone-900' : 'border-stone-300'} bg-stone-50 font-medium text-stone-900`
                      : isSelectable
                        ? `${isStudio ? 'border-stone-900' : 'border-transparent'} font-medium text-stone-900 hover:bg-stone-50 ${
                            isStudio ? '' : 'hover:border-stone-200'
                          }`
                        : `${isStudio ? 'border-stone-900/40' : 'border-transparent'} cursor-default text-stone-300`
                  }`}
                  aria-label={
                    isSelectable
                      ? `${cell.day}${isStudio ? ', studio day' : ''}${hasSlots ? ', open times' : ''}`
                      : `${cell.day}, past`
                  }
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        )}

        {!monthLoading && (
          <p className="mt-3 text-center text-[10px] uppercase tracking-[0.18em] text-stone-400">
            Black border = planned studio day
          </p>
        )}

        {monthError && !monthLoading && (
          <p className="mt-2 text-center text-xs text-stone-500">{monthError}</p>
        )}
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
          <>
            <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-3">
              {slots.map((slot) => {
                const active = selectedSlot === slot;
                const hhmm = slotToStudioLocalHhmm(slot);
                const inStudio =
                  hhmm != null &&
                  isSlotStartInStudioWindows(hhmm, selectedDayWindows);
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => onSelectSlot(slot)}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 ${
                      active
                        ? 'border-stone-300 bg-stone-50 text-stone-900'
                        : 'border-stone-200 bg-white text-stone-800 hover:border-stone-300 hover:bg-stone-50'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        inStudio
                          ? active
                            ? 'bg-emerald-400'
                            : 'bg-emerald-500'
                          : active
                            ? 'bg-stone-700'
                            : 'bg-stone-900'
                      }`}
                      aria-hidden
                    />
                    {formatSlotInStudioTime(slot)}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-center text-[10px] uppercase tracking-[0.18em] text-stone-400">
              Green = studio hours · Black = outside hours
            </p>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-stone-500">
            {selectedDate && selectedDate >= today
              ? 'No open times on this day.'
              : 'Choose a day above to see times.'}
          </p>
        )}
      </div>
    </div>
  );
}
