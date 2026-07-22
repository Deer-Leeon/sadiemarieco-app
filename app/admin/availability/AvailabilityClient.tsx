'use client';

/**
 * AvailabilityClient
 *
 * Client-side orchestrator for the /admin/availability editor. The
 * server component hands over a snapshot of the current Cal.com
 * schedule and from then on this component owns every mutation:
 *
 *   • Weekly Hours — 7 rows, one per weekday, with a toggle and a
 *     pair of HTML `<input type="time">` controls. Days that are
 *     toggled off are simply omitted from the payload on save (Cal
 *     interprets "no entry for Tuesday" as "Tuesday is unbookable").
 *
 *   • Date Overrides — upcoming one-off carve-outs. Past dates move into
 *     an Archived section automatically and are dropped from Cal.com so
 *     the live schedule stays clean.
 *
 * Submission groups recurring entries by identical start/end pairs
 * before sending to Cal — `{ days: [Monday, Wednesday], 09:00, 12:45 }`
 * is the shape Cal's own dashboard produces, and keeping the payload
 * concise makes the schedule legible if the studio ever opens it on
 * the Cal side.
 *
 * Aesthetic posture matches the rest of /admin: cream surface
 * (#FAF9F6), stone palette, serif headings, tracking-wide eyebrow
 * labels in 10px caps. No shadcn / no toast library — we render the
 * success state inline on a sticky save bar so the editor never has
 * to chase a corner of the screen for confirmation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import {
  DAY_INDICES,
  STUDIO_TIMEZONE,
  UNAVAILABLE_TIME,
  dayIndexFromName,
  dayNameFromIndex,
  isUnavailableOverride,
  type DayIndex,
  type DayName,
  type HHMM,
  type Schedule,
  type ScheduleAvailability,
  type ScheduleOverride,
} from './calSchedules';

interface Props {
  initial: Schedule;
}

// ─── State models ─────────────────────────────────────────────────────────

interface WeeklyDayState {
  /** True if the day is bookable. False maps to "no entry" on the wire. */
  enabled: boolean;
  /** HH:MM start (24-hour). Only meaningful when `enabled` is true. */
  startTime: HHMM;
  /** HH:MM end (24-hour). Only meaningful when `enabled` is true. */
  endTime: HHMM;
}

interface OverrideRow {
  /** Local-only React key; never sent to Cal. */
  id: string;
  /** YYYY-MM-DD per the v2 ScheduleOverride spec. */
  date: string;
  /** Toggle: "Unavailable all day" vs "Custom hours". */
  unavailable: boolean;
  /** HH:MM. Ignored on the wire when `unavailable` is true. */
  startTime: HHMM;
  /** HH:MM. Ignored on the wire when `unavailable` is true. */
  endTime: HHMM;
}

const DAY_LABELS: Record<DayIndex, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/** UI default times used for newly enabled days and fresh overrides. */
const DEFAULT_START: HHMM = '09:00';
const DEFAULT_END: HHMM = '17:00';

// ─── Initial-state hydration from Cal's snapshot ──────────────────────────

/**
 * Flatten Cal's `{ days: [Mon, Wed], 09:00, 17:00 }` blocks into a
 * 7-entry record keyed by DayIndex. First-write-wins per day — Cal
 * allows multi-window days (e.g. "9-12 AND 14-17 on Wednesday"), but
 * the spec's UI shows one start + one end per day, so this CMS
 * collapses to a single window. If the studio ever needs split
 * windows, lift this to an array per day and render a "+" button on
 * each row.
 */
function buildInitialWeekly(
  availability: ScheduleAvailability[]
): Record<DayIndex, WeeklyDayState> {
  const out: Record<DayIndex, WeeklyDayState> = {
    0: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    1: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    2: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    3: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    4: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    5: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
    6: { enabled: false, startTime: DEFAULT_START, endTime: DEFAULT_END },
  };
  for (const block of availability) {
    for (const day of block.days) {
      const idx = dayIndexFromName(day);
      if (!out[idx].enabled) {
        out[idx] = {
          enabled: true,
          startTime: block.startTime,
          endTime: block.endTime,
        };
      }
    }
  }
  return out;
}

function buildInitialOverrides(overrides: ScheduleOverride[]): OverrideRow[] {
  return sortOverrideRows(
    overrides.map((o, i) => ({
      id: `${o.date}-${i}`,
      date: o.date,
      unavailable: isUnavailableOverride(o),
      // Preserve the actual times even if currently flagged unavailable
      // — toggling to "Custom hours" should restore something sensible
      // rather than reset to defaults.
      startTime: isUnavailableOverride(o) ? DEFAULT_START : o.startTime,
      endTime: isUnavailableOverride(o) ? DEFAULT_END : o.endTime,
    }))
  );
}

/** Soonest date first (YYYY-MM-DD sorts lexicographically). */
function sortOverrideRows(rows: OverrideRow[]): OverrideRow[] {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.id.localeCompare(b.id);
  });
}

/** Most recent past date first in the archive. */
function sortArchivedOverrideRows(rows: OverrideRow[]): OverrideRow[] {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.id.localeCompare(b.id);
  });
}

/** Studio-local YYYY-MM-DD (America/Denver), not the browser's timezone. */
function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
  }).format(new Date());
}

function partitionOverridesByDate(
  rows: OverrideRow[],
  today: string
): { active: OverrideRow[]; archived: OverrideRow[] } {
  const active: OverrideRow[] = [];
  const archived: OverrideRow[] = [];
  for (const row of rows) {
    if (row.date < today) archived.push(row);
    else active.push(row);
  }
  return {
    active: sortOverrideRows(active),
    archived: sortArchivedOverrideRows(archived),
  };
}

function formatOverrideDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function makeOverrideRow(
  draft: Omit<OverrideRow, 'id'>
): OverrideRow {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...draft,
  };
}

// ─── Payload assembly (UI → wire format) ──────────────────────────────────

/**
 * Bucket active days by `${startTime}|${endTime}` so days sharing
 * identical hours go out as one Cal-side availability block. Keeps
 * the schedule on Cal's dashboard readable instead of producing
 * seven near-identical rows.
 */
function buildAvailabilityPayload(
  weekly: Record<DayIndex, WeeklyDayState>
): ScheduleAvailability[] {
  const buckets = new Map<string, DayName[]>();
  for (const idx of DAY_INDICES) {
    const state = weekly[idx];
    if (!state.enabled) continue;
    const key = `${state.startTime}|${state.endTime}`;
    const days = buckets.get(key) ?? [];
    days.push(dayNameFromIndex(idx));
    buckets.set(key, days);
  }
  return Array.from(buckets.entries()).map(([key, days]) => {
    // Split is safe because both halves are HH:MM strings that never
    // contain the pipe character.
    const [startTime, endTime] = key.split('|');
    return { days, startTime, endTime };
  });
}

function buildOverridesPayload(rows: OverrideRow[]): ScheduleOverride[] {
  return sortOverrideRows(rows).map((r) =>
    r.unavailable
      ? { date: r.date, startTime: UNAVAILABLE_TIME, endTime: UNAVAILABLE_TIME }
      : { date: r.date, startTime: r.startTime, endTime: r.endTime }
  );
}

// ─── Component ────────────────────────────────────────────────────────────

export default function AvailabilityClient({ initial }: Props) {
  const initialPartition = useMemo(
    () =>
      partitionOverridesByDate(
        buildInitialOverrides(initial.overrides),
        todayYmd()
      ),
    // Only hydrate from the server snapshot once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initial.id]
  );

  const [weekly, setWeekly] = useState(() =>
    buildInitialWeekly(initial.availability)
  );
  const [overrides, setOverrides] = useState<OverrideRow[]>(
    () => initialPartition.active
  );
  const [archivedOverrides, setArchivedOverrides] = useState<OverrideRow[]>(
    () => initialPartition.archived
  );
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `savedAt` is the timestamp of the last successful save; the UI
  // shows a confirmation message while it's non-null and auto-clears
  // after 3 s so the editor can keep working without dismissing it.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** Scroll + highlight the row that was just added (sorted to top). */
  const [highlightOverrideId, setHighlightOverrideId] = useState<string | null>(
    null
  );
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  /** Prevent Strict Mode double-fire of the auto-archive Cal sync. */
  const didAutoArchiveRef = useRef(false);

  /**
   * Surface client-side validation as the editor types, so a bad
   * end-before-start window is caught before the save button is
   * clicked. The server-side parser repeats the same checks for
   * defence-in-depth; here we just give the editor a clean inline
   * message and disable the save button.
   */
  const validationErrors = useMemo(() => {
    const out: string[] = [];
    for (const idx of DAY_INDICES) {
      const s = weekly[idx];
      if (s.enabled && s.startTime >= s.endTime) {
        out.push(`${DAY_LABELS[idx]}: end time must be after start time.`);
      }
    }
    for (const r of overrides) {
      if (!r.unavailable && r.startTime >= r.endTime) {
        out.push(`Override ${r.date}: end time must be after start time.`);
      }
    }
    return out;
  }, [weekly, overrides]);

  // Past override dates leave the active list and are dropped from Cal
  // on the next sync so they don't clutter the live schedule.
  useEffect(() => {
    if (didAutoArchiveRef.current) return;
    if (initialPartition.archived.length === 0) return;
    didAutoArchiveRef.current = true;

    const count = initialPartition.archived.length;
    setArchiveNotice(
      count === 1
        ? '1 past date override was archived and removed from Cal.com.'
        : `${count} past date overrides were archived and removed from Cal.com.`
    );
    setArchiveOpen(true);

    void (async () => {
      try {
        const res = await fetch('/api/admin/availability', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleId: initial.id,
            availability: buildAvailabilityPayload(
              buildInitialWeekly(initial.availability)
            ),
            overrides: buildOverridesPayload(initialPartition.active),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error(
            '[admin/availability] auto-archive Cal sync failed',
            data
          );
          setArchiveNotice(
            'Past overrides are archived here, but Cal.com could not be updated automatically — hit Save to sync.'
          );
        }
      } catch (err) {
        console.error('[admin/availability] auto-archive Cal sync failed', err);
        setArchiveNotice(
          'Past overrides are archived here, but Cal.com could not be updated automatically — hit Save to sync.'
        );
      }
    })();
  }, [initial.availability, initial.id, initialPartition]);

  // ── Weekly mutators ─────────────────────────────────────────────────────

  function setDayEnabled(idx: DayIndex, enabled: boolean) {
    setWeekly((prev) => ({ ...prev, [idx]: { ...prev[idx], enabled } }));
  }
  function setDayStart(idx: DayIndex, value: HHMM) {
    setWeekly((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], startTime: value },
    }));
  }
  function setDayEnd(idx: DayIndex, value: HHMM) {
    setWeekly((prev) => ({ ...prev, [idx]: { ...prev[idx], endTime: value } }));
  }

  // ── Override mutators ───────────────────────────────────────────────────

  function confirmAddOverride(draft: Omit<OverrideRow, 'id'>) {
    const row = makeOverrideRow(draft);
    if (row.date < todayYmd()) {
      setArchivedOverrides((prev) =>
        sortArchivedOverrideRows([...prev, row])
      );
      setArchiveOpen(true);
      setAddDialogOpen(false);
      return;
    }
    setOverrides((prev) => sortOverrideRows([...prev, row]));
    setHighlightOverrideId(row.id);
    setAddDialogOpen(false);
  }
  function removeOverride(id: string) {
    setOverrides((prev) => prev.filter((r) => r.id !== id));
    setHighlightOverrideId((prev) => (prev === id ? null : prev));
  }
  function removeArchivedOverride(id: string) {
    setArchivedOverrides((prev) => prev.filter((r) => r.id !== id));
  }
  function patchOverride(id: string, patch: Partial<OverrideRow>) {
    setOverrides((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      const todayStudio = todayYmd();
      const stillActive: OverrideRow[] = [];
      const movedToArchive: OverrideRow[] = [];
      for (const row of next) {
        if (row.date < todayStudio) movedToArchive.push(row);
        else stillActive.push(row);
      }
      if (movedToArchive.length > 0) {
        setArchivedOverrides((archived) =>
          sortArchivedOverrideRows([...archived, ...movedToArchive])
        );
        setArchiveOpen(true);
      }
      return sortOverrideRows(stillActive);
    });
  }

  // ── Save ────────────────────────────────────────────────────────────────

  async function handleSave() {
    setError(null);
    if (validationErrors.length > 0) {
      // The button is also disabled in this state — this is the
      // belt-and-braces case (e.g. keyboard activation racing a
      // validation update).
      setError(validationErrors[0]);
      return;
    }
    setIsSaving(true);
    try {
      // Re-partition in case "today" rolled over while the page was open.
      const partitioned = partitionOverridesByDate(overrides, todayYmd());
      if (partitioned.archived.length > 0) {
        setOverrides(partitioned.active);
        setArchivedOverrides((prev) =>
          sortArchivedOverrideRows([...prev, ...partitioned.archived])
        );
        setArchiveOpen(true);
      }

      const res = await fetch('/api/admin/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleId: initial.id,
          availability: buildAvailabilityPayload(weekly),
          // Past overrides stay in the Archive UI only — never re-pushed to Cal.
          overrides: buildOverridesPayload(partitioned.active),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Save failed.');
      }
      setSavedAt(Date.now());
      // Auto-dismiss the saved confirmation after 3 s so it doesn't
      // accumulate visual noise while the editor keeps tweaking.
      window.setTimeout(() => {
        setSavedAt((prev) => (prev === null ? prev : null));
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-8 pb-[calc(6.5rem+env(safe-area-inset-bottom,0))] max-md:pb-[calc(9rem+env(safe-area-inset-bottom,0))]">
      {/* ── Weekly Hours card ─────────────────────────────────────────── */}
      <section className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <header className="mb-5 flex items-baseline justify-between border-b border-stone-100 pb-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              Recurring
            </p>
            <h2 className="font-serif text-xl text-stone-900">Weekly Hours</h2>
          </div>
          <p className="text-xs text-stone-400">
            Toggle a day off to mark it unbookable. Multiple days that share
            hours collapse to one Cal-side entry on save.
          </p>
        </header>

        <ul className="divide-y divide-stone-100">
          {DAY_INDICES.map((idx) => {
            const state = weekly[idx];
            return (
              <li
                key={idx}
                className="flex flex-wrap items-center justify-between gap-4 py-3"
              >
                <div className="flex min-w-[180px] items-center gap-3">
                  <Toggle
                    checked={state.enabled}
                    onChange={(v) => setDayEnabled(idx, v)}
                    label={`Toggle ${DAY_LABELS[idx]}`}
                  />
                  <span className="font-serif text-sm text-stone-900">
                    {DAY_LABELS[idx]}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {state.enabled ? (
                    <>
                      <TimeInput
                        value={state.startTime}
                        onChange={(v) => setDayStart(idx, v)}
                        ariaLabel={`Start time for ${DAY_LABELS[idx]}`}
                      />
                      <span className="text-stone-400">–</span>
                      <TimeInput
                        value={state.endTime}
                        onChange={(v) => setDayEnd(idx, v)}
                        ariaLabel={`End time for ${DAY_LABELS[idx]}`}
                      />
                    </>
                  ) : (
                    <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
                      Unavailable
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Date Overrides card ───────────────────────────────────────── */}
      <section className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <header className="mb-5 flex items-baseline justify-between gap-3 border-b border-stone-100 pb-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              One-off
            </p>
            <h2 className="font-serif text-xl text-stone-900">Date Overrides</h2>
          </div>
          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700"
          >
            <Plus className="h-3 w-3" />
            Add date override
          </button>
        </header>

        {archiveNotice && (
          <p className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">
            {archiveNotice}
          </p>
        )}

        {overrides.length === 0 ? (
          <p className="py-8 text-center text-sm italic text-stone-400">
            No upcoming date overrides. Add one to close a specific date or
            carve out different hours.
          </p>
        ) : (
          <ul className="space-y-3">
            {overrides.map((row) => (
              <OverrideEditor
                key={row.id}
                row={row}
                highlighted={highlightOverrideId === row.id}
                onHighlightDone={() => setHighlightOverrideId(null)}
                onChange={(patch) => patchOverride(row.id, patch)}
                onRemove={() => removeOverride(row.id)}
              />
            ))}
          </ul>
        )}

        {archivedOverrides.length > 0 && (
          <div className="mt-6 border-t border-stone-100 pt-4">
            <button
              type="button"
              onClick={() => setArchiveOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 text-left"
              aria-expanded={archiveOpen}
            >
              <span className="flex items-center gap-2">
                {archiveOpen ? (
                  <ChevronDown className="h-4 w-4 text-stone-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-stone-400" />
                )}
                <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
                  Archived
                </span>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium tabular-nums text-stone-500">
                  {archivedOverrides.length}
                </span>
              </span>
              <span className="text-xs text-stone-400">
                Past dates — kept for reference, not sent to Cal
              </span>
            </button>

            {archiveOpen && (
              <ul className="mt-3 space-y-2">
                {archivedOverrides.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50/80 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-700">
                        {formatOverrideDateLabel(row.date)}
                      </p>
                      <p className="mt-0.5 text-xs text-stone-500">
                        {row.unavailable
                          ? 'Unavailable all day'
                          : `${row.startTime} – ${row.endTime}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeArchivedOverride(row.id)}
                      aria-label={`Dismiss archived override ${row.date}`}
                      className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                    >
                      <Trash2 className="h-3 w-3" />
                      Dismiss
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {addDialogOpen && (
        <AddOverrideDialog
          onClose={() => setAddDialogOpen(false)}
          onConfirm={confirmAddOverride}
        />
      )}

      <DockedSaveBar
        savedAt={savedAt}
        error={error}
        validationErrors={validationErrors}
        isSaving={isSaving}
        onSave={handleSave}
      />

      <p className="text-center text-[10px] uppercase tracking-[0.22em] text-stone-400">
        All times in {STUDIO_TIMEZONE.replace('_', ' ')}.
      </p>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

/**
 * Rendered via portal on `document.body` so `position: fixed` always
 * anchors to the viewport (not a scroll parent). On mobile the bar is
 * flush to the physical bottom with only safe-area inset padding.
 */
function DockedSaveBar({
  savedAt,
  error,
  validationErrors,
  isSaving,
  onSave,
}: {
  savedAt: number | null;
  error: string | null;
  validationErrors: string[];
  isSaving: boolean;
  onSave: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <div
      role="region"
      aria-label="Save availability"
      className="fixed right-0 bottom-0 left-0 z-100 border-t border-stone-200 bg-[#FAF9F6] shadow-[0_-8px_30px_-12px_rgba(28,25,23,0.18)] max-md:pb-[env(safe-area-inset-bottom)] md:bg-[#FAF9F6]/95 md:backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 pt-2.5 pb-3 max-md:gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <StatusLine
            savedAt={savedAt}
            error={error}
            validationErrors={validationErrors}
          />
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving || validationErrors.length > 0}
          className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-full bg-stone-900 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-[#FAF9F6] transition-colors hover:bg-stone-700 disabled:opacity-50 sm:w-auto"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              Save changes
            </>
          )}
        </button>
      </div>
    </div>,
    document.body
  );
}

function StatusLine({
  savedAt,
  error,
  validationErrors,
}: {
  savedAt: number | null;
  error: string | null;
  validationErrors: string[];
}) {
  if (savedAt !== null) {
    return (
      <p className="truncate text-xs text-emerald-700">
        Saved — Cal.com is now serving these hours.
      </p>
    );
  }
  if (error) {
    return <p className="truncate text-xs text-rose-700">{error}</p>;
  }
  if (validationErrors.length > 0) {
    return (
      <p className="truncate text-xs text-rose-700">{validationErrors[0]}</p>
    );
  }
  return (
    <p className="text-xs leading-snug text-stone-500 max-md:line-clamp-2 sm:truncate">
      Changes will sync to Cal.com on save.
    </p>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/40 ${
        checked ? 'bg-stone-900' : 'bg-stone-300'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function TimeInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: HHMM;
  onChange: (next: HHMM) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="time"
      // 15-minute step matches what Cal.com itself uses on its
      // dashboard, and lines up with the studio's typical service
      // durations (30/45/60/75 min). 60 * 15 = 900 seconds.
      step={900}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
    />
  );
}

function OverrideEditor({
  row,
  highlighted = false,
  onHighlightDone,
  onChange,
  onRemove,
}: {
  row: OverrideRow;
  highlighted?: boolean;
  onHighlightDone?: () => void;
  onChange: (patch: Partial<OverrideRow>) => void;
  onRemove: () => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!highlighted || !rowRef.current) return;
    rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const clear = window.setTimeout(() => onHighlightDone?.(), 1600);
    return () => window.clearTimeout(clear);
    // onHighlightDone is stable enough for a one-shot highlight clear;
    // including it would re-fire scroll on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted]);

  return (
    <li
      ref={rowRef}
      className={`rounded-lg border bg-stone-50/50 p-4 transition-[box-shadow,border-color,background-color] duration-500 ${
        highlighted
          ? 'border-stone-900 bg-stone-100 shadow-sm ring-2 ring-stone-900/15'
          : 'border-stone-200'
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-3.5 w-3.5 text-stone-400" aria-hidden="true" />
          <input
            type="date"
            value={row.date}
            onChange={(e) => onChange({ date: e.target.value })}
            aria-label="Override date"
            className="rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
          />
        </div>

        <fieldset className="flex items-center gap-3 text-xs text-stone-700">
          <legend className="sr-only">Override type</legend>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${row.id}`}
              checked={row.unavailable}
              onChange={() => onChange({ unavailable: true })}
              className="h-3 w-3 text-stone-900 focus:ring-stone-900"
            />
            Unavailable all day
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${row.id}`}
              checked={!row.unavailable}
              onChange={() => onChange({ unavailable: false })}
              className="h-3 w-3 text-stone-900 focus:ring-stone-900"
            />
            Custom hours
          </label>
        </fieldset>

        {!row.unavailable && (
          <div className="flex items-center gap-2">
            <TimeInput
              value={row.startTime}
              onChange={(v) => onChange({ startTime: v })}
              ariaLabel="Override start time"
            />
            <span className="text-stone-400">–</span>
            <TimeInput
              value={row.endTime}
              onChange={(v) => onChange({ endTime: v })}
              ariaLabel="Override end time"
            />
          </div>
        )}

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove override"
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>
    </li>
  );
}

/**
 * Collects date + mode (+ optional hours) before committing a new
 * override into the list. Mirrors BlockTimeDialog styling so the
 * admin chrome feels consistent.
 */
function AddOverrideDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (draft: Omit<OverrideRow, 'id'>) => void;
}) {
  const [date, setDate] = useState(todayYmd);
  const [unavailable, setUnavailable] = useState(true);
  const [startTime, setStartTime] = useState<HHMM>(DEFAULT_START);
  const [endTime, setEndTime] = useState<HHMM>(DEFAULT_END);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFormError('Pick a valid date.');
      return;
    }
    if (!unavailable && startTime >= endTime) {
      setFormError('End time must be after start time.');
      return;
    }

    onConfirm({
      date,
      unavailable,
      startTime,
      endTime,
    });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-110 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-200/80 bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-override-title"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-6">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              Date override
            </p>
            <h3
              id="add-override-title"
              className="font-serif text-xl leading-tight text-stone-900"
            >
              Add date override
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              Close a specific day or set different hours. Changes sync to
              Cal.com when you save.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4 px-6 pb-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
              Date
            </span>
            <input
              type="date"
              value={date}
              min={todayYmd()}
              onChange={(e) => setDate(e.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
            />
          </label>

          <fieldset>
            <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">
              Hours
            </legend>
            <div className="flex flex-col gap-2">
              <label className="inline-flex items-center gap-2 text-sm text-stone-800">
                <input
                  type="radio"
                  name="override-mode"
                  checked={unavailable}
                  onChange={() => setUnavailable(true)}
                  className="h-3.5 w-3.5 text-stone-900 focus:ring-stone-900"
                />
                Unavailable all day
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-stone-800">
                <input
                  type="radio"
                  name="override-mode"
                  checked={!unavailable}
                  onChange={() => setUnavailable(false)}
                  className="h-3.5 w-3.5 text-stone-900 focus:ring-stone-900"
                />
                Custom hours
              </label>
            </div>
          </fieldset>

          {!unavailable && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
                  Start
                </span>
                <input
                  type="time"
                  step={900}
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  required
                  className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
                  End
                </span>
                <input
                  type="time"
                  step={900}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  required
                  className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
                />
              </label>
            </div>
          )}

          {formError && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-stone-200/70 pt-4 pb-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-stone-50 transition-colors hover:bg-stone-800"
            >
              Add override
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
