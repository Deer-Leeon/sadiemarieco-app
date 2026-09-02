'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import {
  isAppointmentWithinStudioWindows,
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
  occupiedStartMsFromSlotsPayload,
  slotMatchesStudioHour,
  slotsGroupedByStudioDate,
  slotToStudioLocalHhmm,
  STUDIO_TIMEZONE,
  todayInStudio,
} from './manual-booking-utils';
import { studioDateKey } from '@/lib/studio-calendar';

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

function monthCacheKey(eventTypeId: number, year: number, month: number): string {
  return `${eventTypeId}-${year}-${month}`;
}

function shiftYearMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return { year: y, month: m };
}

type MonthCacheEntry = {
  slotsByDay: Record<string, string[]>;
  availableDates: string[];
  studioDaySet: Set<string>;
  availability: StudioAvailabilityBlock[];
  overrides: StudioDateOverride[];
  occupiedStartMs: Set<number>;
  error: string | null;
};

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
  /** Service length — used so dots go black when the appointment would overrun studio hours. */
  durationMins: number | null;
  selectedSlot: string | null;
  onSelectSlot: (isoUtc: string | null) => void;
  /** Studio calendar day to open on (from a time-grid hour click). */
  seedDate?: Date;
  /** 0–23 studio hour to pre-select once slots load. */
  seedHour?: number;
}

export default function ManualBookingSlotPicker({
  eventTypeId,
  clientName,
  durationMins,
  selectedSlot,
  onSelectSlot,
  seedDate,
  seedHour,
}: Props) {
  const today = todayInStudio();
  const seedYmdRaw = seedDate ? studioDateKey(seedDate) : '';
  const seedYmd =
    seedYmdRaw && seedYmdRaw >= today ? seedYmdRaw : null;
  const startYmd = seedYmd ?? today;
  const initial = parseStudioDate(startYmd);

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
  const [occupiedStartMs, setOccupiedStartMs] = useState<Set<number>>(
    () => new Set()
  );
  /** Skip empty current month once on open so admins land on the next bookable month. */
  const mayAdvanceFromEmptyStart = useRef(!seedYmd);
  const seededSlotAppliedRef = useRef(false);
  const monthCacheRef = useRef<Map<string, MonthCacheEntry>>(new Map());
  const monthInflightRef = useRef<Map<string, Promise<MonthCacheEntry>>>(new Map());
  const monthLoadGenRef = useRef(0);
  const onSelectSlotRef = useRef(onSelectSlot);

  useEffect(() => {
    onSelectSlotRef.current = onSelectSlot;
  }, [onSelectSlot]);

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

  const applyMonthEntry = useCallback(
    (entry: MonthCacheEntry, year: number, month: number) => {
      setMonthSlots(entry.slotsByDay);
      setAvailableDates(entry.availableDates);
      setStudioDaySet(entry.studioDaySet);
      setScheduleAvailability(entry.availability);
      setScheduleOverrides(entry.overrides);
      setOccupiedStartMs(entry.occupiedStartMs);
      setMonthError(entry.error);

      if (entry.availableDates.length === 0) {
        if (seedYmd && isStudioDateInMonth(seedYmd, year, month)) {
          setSelectedDate(seedYmd);
        } else {
          setSelectedDate(null);
        }
        onSelectSlotRef.current(null);
        return;
      }

      const seedInMonth =
        seedYmd &&
        isStudioDateInMonth(seedYmd, year, month) &&
        (entry.availableDates.includes(seedYmd) || seedYmd >= today);

      const defaultDate = seedInMonth
        ? seedYmd
        : entry.availableDates.includes(today) &&
            isStudioDateInMonth(today, year, month)
          ? today
          : entry.availableDates[0];
      setSelectedDate(defaultDate);
      if (!(seedYmd && defaultDate === seedYmd && seedHour != null)) {
        onSelectSlotRef.current(null);
      }
    },
    [today, seedYmd, seedHour]
  );

  const fetchMonthEntry = useCallback(
    async (year: number, month: number): Promise<MonthCacheEntry> => {
      const key = monthCacheKey(eventTypeId, year, month);
      const cached = monthCacheRef.current.get(key);
      if (cached) return cached;
      const inflight = monthInflightRef.current.get(key);
      if (inflight) return inflight;

      const pending = (async (): Promise<MonthCacheEntry> => {
        const rangeStart = studioDateString(year, month, 1);
        const rangeEnd = studioDateString(year, month, lastDayOfMonth(year, month));
        const queryStart = rangeStart < today ? today : rangeStart;

        if (queryStart > rangeEnd) {
          const entry: MonthCacheEntry = {
            slotsByDay: {},
            availableDates: [],
            studioDaySet: new Set(),
            availability: [],
            overrides: [],
            occupiedStartMs: new Set(),
            error: 'No open days left this month.',
          };
          monthCacheRef.current.set(key, entry);
          return entry;
        }

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

        let availability: StudioAvailabilityBlock[] = [];
        let overrides: StudioDateOverride[] = [];
        let studioDays = new Set<string>();
        const schedule = scheduleRes.ok ? parseSchedulePayload(scheduleData) : null;
        if (schedule) {
          availability = schedule.availability;
          overrides = schedule.overrides;
          studioDays = studioDaysInRange(
            rangeStart,
            rangeEnd,
            schedule.availability,
            schedule.overrides
          );
        }

        if (!slotsRes.ok) {
          const message =
            slotsData &&
            typeof slotsData === 'object' &&
            'message' in slotsData &&
            typeof (slotsData as { message: unknown }).message === 'string'
              ? (slotsData as { message: string }).message
              : `Could not load availability (HTTP ${slotsRes.status})`;
          throw new Error(message);
        }

        const grouped = slotsGroupedByStudioDate(slotsData, {
          rangeStart: queryStart,
          rangeEnd: rangeEnd,
        });
        const occupiedStartMs = occupiedStartMsFromSlotsPayload(slotsData);

        const slotsByDay: Record<string, string[]> = {};
        for (const [date, times] of Object.entries(grouped)) {
          if (!isStudioDateInMonth(date, year, month)) continue;
          const filtered = filterSlotsForBookingDay(times, date, today);
          if (filtered.length > 0) {
            slotsByDay[date] = filtered;
          }
        }

        const openDates = Object.keys(slotsByDay).sort();
        const entry: MonthCacheEntry = {
          slotsByDay,
          availableDates: openDates,
          studioDaySet: studioDays,
          availability,
          overrides,
          occupiedStartMs,
          error:
            openDates.length === 0
              ? `No open days in ${monthLabel(year, month)}. Try another month.`
              : null,
        };
        monthCacheRef.current.set(key, entry);
        return entry;
      })();

      monthInflightRef.current.set(key, pending);
      try {
        return await pending;
      } finally {
        monthInflightRef.current.delete(key);
      }
    },
    [eventTypeId, today]
  );

  const prefetchMonth = useCallback(
    (year: number, month: number) => {
      const key = monthCacheKey(eventTypeId, year, month);
      if (monthCacheRef.current.has(key) || monthInflightRef.current.has(key)) {
        return;
      }
      void fetchMonthEntry(year, month).catch(() => {
        /* next navigation will retry */
      });
    },
    [eventTypeId, fetchMonthEntry]
  );

  const loadMonth = useCallback(
    async (year: number, month: number) => {
      const loadGen = monthLoadGenRef.current + 1;
      monthLoadGenRef.current = loadGen;
      const stillCurrent = () => monthLoadGenRef.current === loadGen;

      const cached = monthCacheRef.current.get(
        monthCacheKey(eventTypeId, year, month)
      );
      if (cached) {
        if (
          cached.availableDates.length === 0 &&
          mayAdvanceFromEmptyStart.current &&
          year === initial.year &&
          month === initial.month &&
          cached.error !== 'No open days left this month.'
        ) {
          mayAdvanceFromEmptyStart.current = false;
          const next = shiftYearMonth(year, month, 1);
          setViewYear(next.year);
          setViewMonth(next.month);
          return;
        }
        applyMonthEntry(cached, year, month);
        setMonthLoading(false);
        const next = shiftYearMonth(year, month, 1);
        prefetchMonth(next.year, next.month);
        return;
      }

      setMonthLoading(true);
      setMonthError(null);
      setSelectedDate(null);
      onSelectSlotRef.current(null);

      try {
        const entry = await fetchMonthEntry(year, month);
        if (!stillCurrent()) return;

        if (
          entry.availableDates.length === 0 &&
          mayAdvanceFromEmptyStart.current &&
          year === initial.year &&
          month === initial.month &&
          !entry.error?.startsWith('Could not') &&
          entry.error !== 'No open days left this month.'
        ) {
          mayAdvanceFromEmptyStart.current = false;
          const next = shiftYearMonth(year, month, 1);
          setViewYear(next.year);
          setViewMonth(next.month);
          return;
        }

        mayAdvanceFromEmptyStart.current = false;
        applyMonthEntry(entry, year, month);
        const next = shiftYearMonth(year, month, 1);
        prefetchMonth(next.year, next.month);
      } catch (err) {
        if (!stillCurrent()) return;
        setSelectedDate(null);
        setMonthError(
          err instanceof Error ? err.message : 'Failed to load availability'
        );
      } finally {
        if (stillCurrent()) setMonthLoading(false);
      }
    },
    [
      applyMonthEntry,
      eventTypeId,
      fetchMonthEntry,
      initial.month,
      initial.year,
      prefetchMonth,
    ]
  );

  useEffect(() => {
    void loadMonth(viewYear, viewMonth);
  }, [viewYear, viewMonth, loadMonth]);

  useEffect(() => {
    if (seedHour == null || !seedYmd) return;
    if (selectedDate !== seedYmd) return;
    if (seededSlotAppliedRef.current) return;
    const times = filterSlotsForBookingDay(
      monthSlots[selectedDate] ?? [],
      selectedDate,
      today
    );
    const match = times.find((iso) => slotMatchesStudioHour(iso, seedHour));
    if (!match) return;
    seededSlotAppliedRef.current = true;
    onSelectSlotRef.current(match);
  }, [selectedDate, monthSlots, seedHour, seedYmd, today]);

  const slots =
    selectedDate && selectedDate >= today
      ? filterSlotsForBookingDay(monthSlots[selectedDate] ?? [], selectedDate, today)
      : [];
  const slotsLoading = monthLoading && !selectedDate;

  function shiftMonth(delta: number) {
    const next = shiftYearMonth(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="font-medium text-stone-900">{monthLabel(viewYear, viewMonth)}</p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200"
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
                  aria-pressed={isSelected}
                  aria-current={isSelected ? 'date' : undefined}
                  className={`flex h-9 w-full items-center justify-center rounded-full border text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 ${
                    isSelected
                      ? 'border-stone-900 bg-stone-900 font-semibold text-white'
                      : isSelectable
                        ? `${isStudio ? 'border-stone-900' : 'border-transparent'} font-medium text-stone-900 hover:bg-stone-100 ${
                            isStudio ? '' : 'hover:border-stone-200'
                          }`
                        : `${isStudio ? 'border-stone-900/40' : 'border-transparent'} cursor-default text-stone-300`
                  }`}
                  aria-label={
                    isSelectable
                      ? `${cell.day}${isSelected ? ', selected' : ''}${isStudio ? ', studio day' : ''}${hasSlots ? ', open times' : ''}`
                      : `${cell.day}, past`
                  }
                >
                  {cell.day}
                </button>
              );
            })}
        </div>

        <p className="mt-3 text-center text-[10px] uppercase tracking-[0.18em] text-stone-400">
          Filled = selected day · Black border = planned studio day
        </p>

        {monthError ? (
          <p className="mt-2 text-center text-xs text-stone-500">{monthError}</p>
        ) : null}
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
            <div className="grid max-h-52 grid-cols-2 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-3">
              {slots.map((slot) => {
                const active = selectedSlot === slot;
                const hhmm = slotToStudioLocalHhmm(slot);
                const inStudio =
                  hhmm != null &&
                  isAppointmentWithinStudioWindows(
                    hhmm,
                    durationMins,
                    selectedDayWindows
                  );
                const occupied = occupiedStartMs.has(
                  new Date(slot).getTime()
                );
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => onSelectSlot(slot)}
                    aria-pressed={active}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-200 ${
                      active
                        ? 'border-stone-900 bg-stone-900 text-white shadow-sm'
                        : occupied
                          ? 'border-amber-200 bg-amber-50/70 text-stone-800 hover:border-amber-300 hover:bg-amber-50'
                          : 'border-stone-200 bg-white text-stone-800 hover:border-stone-300 hover:bg-stone-50'
                    }`}
                  >
                    <span className="flex items-center justify-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          active
                            ? occupied
                              ? 'bg-amber-300'
                              : inStudio
                                ? 'bg-emerald-400'
                                : 'bg-white'
                            : occupied
                              ? 'bg-amber-500'
                              : inStudio
                                ? 'bg-emerald-500'
                                : 'bg-stone-900'
                        }`}
                        aria-hidden
                      />
                      {formatSlotInStudioTime(slot)}
                    </span>
                    {occupied ? (
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wide ${
                          active ? 'text-amber-200' : 'text-amber-800'
                        }`}
                      >
                        Busy
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-center text-[10px] uppercase tracking-[0.18em] text-stone-400">
              Filled = selected · Green = fits studio hours · Amber = already
              booked (admin can still double-book) · Black = outside or overruns
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
