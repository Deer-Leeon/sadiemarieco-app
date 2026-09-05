'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addDays, addWeeks, subDays, subWeeks } from 'date-fns';
import {
  Calendar,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  List,
  Plus,
} from 'lucide-react';

import {
  addStudioCalendarDays,
  calendarDayUtcNoon,
  formatStudioNavDay,
  studioDateKey,
  studioWeekdaySun0,
  todayStudioDateKey,
} from '@/lib/studio-calendar';
import {
  parseAvailabilityPayload,
  type StudioAvailabilityBlock,
  type StudioDateOverride,
} from '@/lib/studio-schedule-windows';

import ManualBookingModal from './components/ManualBookingModal';
import CalendarSlotActionDialog, {
  type CalendarSlotAction,
} from './CalendarSlotActionDialog';
import type {
  ManualBookingServiceGroupHeader,
  ManualBookingServiceOption,
} from './components/manual-booking-utils';
import type { Appointment, Client, TerminalPaymentSummary, TimeBlock, ViewMode } from './types';
import {
  appointmentBelongsToClient,
  withClientNoShowFlag,
} from './clientNoShowFlagSync';
import { isAttachedExtra, withPatchedPayments } from '@/lib/appointment-extras';
import AdminHeader from './AdminHeader';
import AdminSectionTabs from './AdminSectionTabs';
import ListView from './ListView';
import CalendarView from './CalendarView';
import TimeGrid from './TimeGrid';
import SingleDayModal from './SingleDayModal';
import AppointmentModal from './AppointmentModal';
import BlockTimeDialog from './BlockTimeDialog';
import RemoveBlockDialog from './components/RemoveBlockDialog';
import {
  deleteTimeBlock,
  isIngestedTimeBlockAppointment,
  mergeGhostTimeBlocks,
  timeBlockCalUidSet,
} from './time-block-helpers';
import { allCalBookingUids } from '@/lib/cal-time-block-segments';

interface Props {
  appointments: Appointment[];
  timeBlocks: TimeBlock[];
  dbError: string | null;
  displayName: string;
  manualBookingServices: ManualBookingServiceOption[];
  manualBookingGroupHeaders: ManualBookingServiceGroupHeader[];
}

/**
 * Client-side orchestrator for the admin dashboard.
 *
 * Layout invariants (do not break without re-reading the spec):
 *   - Outermost container is the only screen-height element. It uses
 *     `h-screen overflow-hidden flex flex-col` to prevent the page from
 *     ever scrolling. Background tinted to the cream/champagne base.
 *   - Header is intrinsic-height (no flex-1, no fixed height).
 *   - When a time-grid view is active a thin DateNav row sits between
 *     header and main, also intrinsic-height.
 *   - Main content area is `flex-1 overflow-hidden`. ONLY the inner
 *     list/calendar/time-grid views are allowed to introduce their own
 *     scroll containers, never this outer main.
 *
 * State ownership:
 *   - `view` drives which body component renders.
 *   - `currentDate` is shared between the 3-day and week TimeGrid views
 *     so swapping between them keeps the user on the same logical week.
 *     (Switching to/from month/list does NOT reset it.) The TimeGrid
 *     component itself is purely presentational — DashboardUI owns
 *     navigation state.
 */
export default function DashboardUI({
  appointments: appointmentsProp,
  timeBlocks,
  dbError,
  displayName,
  manualBookingServices,
  manualBookingGroupHeaders,
}: Props) {
  const router = useRouter();
  // Desktop Bookings lands on the Sun–Sat week grid (today's week).
  // Narrow viewports keep the month calendar — seven hour-columns are
  // cramped on a phone, and the toggle still lets either size switch.
  const [view, setView] = useState<ViewMode>('week');
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)').matches;
    if (!desktop) setView('month');
  }, []);
  const [currentDate, setCurrentDate] = useState<Date>(() =>
    calendarDayUtcNoon(todayStudioDateKey())
  );
  // Live appointment list so clearing a no-show flag updates calendar
  // pills immediately without waiting on router.refresh().
  const [appointments, setAppointments] = useState(appointmentsProp);
  useEffect(() => {
    setAppointments(appointmentsProp);
  }, [appointmentsProp]);
  // `modalDate` doubles as both the "is the modal open?" boolean and
  // the initialDate passed in. Null = closed. Stored as Date (not ISO
  // string) because consumers (TimeGrid → SingleDayModal) speak Date.
  const [modalDate, setModalDate] = useState<Date | null>(null);
  // `selectedAppointment` drives the AppointmentModal overlay. It
  // lives alongside `modalDate` so the two modals can be open at the
  // same time — clicking a pill inside SingleDayModal layers the
  // appointment details on top without dismissing the day view.
  // Closing the appointment modal returns the editor to whatever was
  // beneath it (day modal, or the underlying calendar).
  const [selectedAppointment, setSelectedAppointment] =
    useState<Appointment | null>(null);
  const [manualBookingOpen, setManualBookingOpen] = useState(false);
  const [slotAction, setSlotAction] = useState<CalendarSlotAction | null>(
    null
  );
  const [bookingToast, setBookingToast] = useState<string | null>(null);
  useEffect(() => {
    if (!bookingToast) return;
    const timer = window.setTimeout(() => setBookingToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [bookingToast]);
  const [blockPendingEdit, setBlockPendingEdit] = useState<TimeBlock | null>(
    null
  );
  const [blockPendingRemove, setBlockPendingRemove] = useState<TimeBlock | null>(
    null
  );
  const [removingBlockId, setRemovingBlockId] = useState<string | null>(null);
  const [removedBlockIds, setRemovedBlockIds] = useState<Set<string>>(
    () => new Set()
  );
  const [removedBlockCalUids, setRemovedBlockCalUids] = useState<Set<string>>(
    () => new Set()
  );
  const [scheduleAvailability, setScheduleAvailability] = useState<
    StudioAvailabilityBlock[] | null
  >(null);
  const [scheduleOverrides, setScheduleOverrides] = useState<
    StudioDateOverride[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/availability');
        if (!res.ok) return;
        const parsed = parseAvailabilityPayload(await res.json());
        if (!parsed || cancelled) return;
        setScheduleAvailability(parsed.availability);
        setScheduleOverrides(parsed.overrides);
      } catch {
        // Leave null — time grids stay unhatched until a later refresh.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const timeBlockCalUids = useMemo(
    () => timeBlockCalUidSet(timeBlocks),
    [timeBlocks]
  );

  const displayTimeBlocks = useMemo(
    () =>
      mergeGhostTimeBlocks(timeBlocks, appointments).filter((b) => {
        if (removedBlockIds.has(b.id)) return false;
        if (allCalBookingUids(b).some((uid) => removedBlockCalUids.has(uid))) {
          return false;
        }
        return true;
      }),
    [timeBlocks, appointments, removedBlockIds, removedBlockCalUids]
  );

  const appointmentsWithoutTimeBlockGhosts = useMemo(
    () =>
      appointments.filter(
        (a) => !isIngestedTimeBlockAppointment(a, timeBlockCalUids)
      ),
    [appointments, timeBlockCalUids]
  );

  async function handleConfirmRemoveBlock() {
    if (!blockPendingRemove || removingBlockId) return;

    const blockId = blockPendingRemove.id;
    const calUids = allCalBookingUids(blockPendingRemove);

    setRemovingBlockId(blockId);
    setRemovedBlockIds((prev) => new Set(prev).add(blockId));
    if (calUids.length > 0) {
      setRemovedBlockCalUids((prev) => {
        const next = new Set(prev);
        for (const uid of calUids) next.add(uid);
        return next;
      });
    }
    setBlockPendingRemove(null);
    setBlockPendingEdit(null);

    const result = await deleteTimeBlock(blockId);
    setRemovingBlockId(null);

    if (!result.ok) {
      setRemovedBlockIds((prev) => {
        const next = new Set(prev);
        next.delete(blockId);
        return next;
      });
      if (calUids.length > 0) {
        setRemovedBlockCalUids((prev) => {
          const next = new Set(prev);
          for (const uid of calUids) next.delete(uid);
          return next;
        });
      }
      setBookingToast(result.message);
      return;
    }

    if (result.warning) {
      setBookingToast(
        `Block removed. Cal.com may still show the hold — check your calendar if the slot stays blocked.`
      );
    }

    router.refresh();
  }

  /** Clear (or re-set) calendar pill flags as soon as the CRM client changes. */
  function handleClientNoShowFlagChanged(client: Client) {
    const flag = Boolean(client.no_show_flag);
    setAppointments((prev) => withClientNoShowFlag(prev, client, flag));
    setSelectedAppointment((prev) =>
      prev && appointmentBelongsToClient(prev, client)
        ? { ...prev, client_no_show_flag: flag }
        : prev
    );
    router.refresh();
  }

  /** Patch settlement markers in the open modal + calendar/list immediately. */
  function handlePaymentUpdated(
    payment: TerminalPaymentSummary | null,
    appointmentIds?: string[],
    payments?: TerminalPaymentSummary[] | null
  ) {
    const ids = appointmentIds?.length
      ? appointmentIds
      : selectedAppointment
        ? [selectedAppointment.id]
        : [];
    setSelectedAppointment((prev) =>
      prev && (ids.includes(prev.id) || prev.extras?.some((e) => ids.includes(e.id)))
        ? withPatchedPayments(prev, ids, payment, payments)
        : prev
    );
    setAppointments((prev) =>
      prev.map((a) =>
        ids.includes(a.id) || a.extras?.some((e) => ids.includes(e.id))
          ? withPatchedPayments(a, ids, payment, payments)
          : a
      )
    );
  }

  const showDateNav = view === '3day' || view === 'week';

  // Shared by List, Month, 3-day, Week, and the day modal so every
  // surface shows the same bookings. Only confirmed / no-show rows —
  // pending checkout holds and canceled bookings stay hidden.
  const visibleAppointments = useMemo(
    () =>
      appointmentsWithoutTimeBlockGhosts.filter((a) => {
        const s = (a.status || '').toLowerCase();
        return (
          !isAttachedExtra(a) &&
          s !== 'pending' &&
          s !== 'canceled_by_admin' &&
          s !== 'canceled_by_client' &&
          s !== 'canceled_by_client_late' &&
          s !== 'canceled_by_system'
        );
      }),
    [appointmentsWithoutTimeBlockGhosts]
  );

  return (
    <div className="h-screen w-full overflow-hidden flex flex-col bg-[#FAF9F6] text-stone-900 font-sans">
      <AdminHeader title="Bookings" displayName={displayName}>
        <div className="inline-flex items-center rounded-full border border-stone-200 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setManualBookingOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-stone-800 transition-colors hover:bg-stone-50 hover:text-stone-900"
          >
            <Plus className="h-3 w-3 text-stone-500" strokeWidth={2} />
            <span className="font-serif leading-none">New booking</span>
          </button>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </AdminHeader>

      <AdminSectionTabs />

      {showDateNav && (
        <DateNav
          view={view}
          currentDate={currentDate}
          onChange={setCurrentDate}
        />
      )}

      <main className="flex-1 overflow-hidden">
        {dbError ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Could not load bookings: {dbError}
            </div>
          </div>
        ) : view === 'list' ? (
          // List view is the only mode where "0 bookings" has nothing
          // meaningful to render — show an empty-state instead of a
          // blank scroll region. The other views (3-day / week / month)
          // always render their date grid so the studio still has a
          // calendar to look at when scheduling is light.
          visibleAppointments.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-stone-500">No bookings yet.</p>
            </div>
          ) : (
            <ListView appointments={visibleAppointments} />
          )
        ) : view === 'month' ? (
          <CalendarView
            appointments={visibleAppointments}
            timeBlocks={displayTimeBlocks}
            removingBlockId={removingBlockId}
            onAppointmentClick={setSelectedAppointment}
            onBlockClick={setBlockPendingEdit}
            onDayClick={setModalDate}
          />
        ) : view === '3day' ? (
          <TimeGrid
            appointments={visibleAppointments}
            timeBlocks={displayTimeBlocks}
            removingBlockId={removingBlockId}
            currentDate={currentDate}
            daysToShow={3}
            onDayClick={setModalDate}
            onAppointmentClick={setSelectedAppointment}
            onBlockClick={setBlockPendingEdit}
            onHourClick={(date, hour) => setSlotAction({ date, hour })}
            scheduleAvailability={scheduleAvailability}
            scheduleOverrides={scheduleOverrides}
          />
        ) : (
          <TimeGrid
            appointments={visibleAppointments}
            timeBlocks={displayTimeBlocks}
            removingBlockId={removingBlockId}
            currentDate={currentDate}
            daysToShow={7}
            onDayClick={setModalDate}
            onAppointmentClick={setSelectedAppointment}
            onBlockClick={setBlockPendingEdit}
            onHourClick={(date, hour) => setSlotAction({ date, hour })}
            scheduleAvailability={scheduleAvailability}
            scheduleOverrides={scheduleOverrides}
          />
        )}
      </main>

      {/* ── Modal portal ───────────────────────────────────────────────
          Both modals render here at the root so their `fixed inset-0`
          backdrops always overlay everything above them regardless of
          which view is active. Conditional render (not just hidden)
          so timeline body / keyboard listeners only mount when the
          modal is actually open.

          Stacking order: SingleDayModal at z-50 (default for the
          existing implementation), AppointmentModal at z-60 so a
          click on a pill inside the day modal layers the details
          card on top rather than fighting it for stacking context. */}
      {modalDate !== null && (
        <SingleDayModal
          appointments={visibleAppointments}
          timeBlocks={displayTimeBlocks}
          initialDate={modalDate}
          removingBlockId={removingBlockId}
          onClose={() => setModalDate(null)}
          onAppointmentClick={setSelectedAppointment}
          onBlockClick={setBlockPendingEdit}
          onHourClick={(date, hour) => setSlotAction({ date, hour })}
          ignoreEscape={slotAction !== null}
          scheduleAvailability={scheduleAvailability}
          scheduleOverrides={scheduleOverrides}
        />
      )}
      {blockPendingEdit !== null && (
        <BlockTimeDialog
          activeDate={calendarDayUtcNoon(
            studioDateKey(blockPendingEdit.start_time)
          )}
          editingBlock={blockPendingEdit}
          onClose={() => {
            if (removingBlockId) return;
            setBlockPendingEdit(null);
          }}
          onUpdated={(infoMessage) => {
            if (infoMessage) setBookingToast(infoMessage);
            setBlockPendingEdit(null);
            router.refresh();
          }}
          onRequestRemove={(block) => {
            setBlockPendingRemove(block);
          }}
        />
      )}
      {blockPendingRemove !== null && (
        <RemoveBlockDialog
          block={blockPendingRemove}
          busy={removingBlockId === blockPendingRemove.id}
          onCancel={() => {
            if (removingBlockId) return;
            setBlockPendingRemove(null);
          }}
          onConfirm={handleConfirmRemoveBlock}
        />
      )}
      {selectedAppointment !== null && (
        <AppointmentModal
          appointment={selectedAppointment}
          onClose={() => setSelectedAppointment(null)}
          onClientUpdated={handleClientNoShowFlagChanged}
          onPaymentUpdated={handlePaymentUpdated}
          onExtrasUpdated={(extras) => {
            setSelectedAppointment((prev) =>
              prev
                ? { ...prev, extras, extra_count: extras.length }
                : prev
            );
            setAppointments((prev) =>
              prev.map((a) =>
                a.id === selectedAppointment.id
                  ? { ...a, extras, extra_count: extras.length }
                  : a
              )
            );
          }}
          siblingCandidates={appointments}
          catalogueServices={manualBookingServices}
          catalogueGroupHeaders={manualBookingGroupHeaders}
        />
      )}

      {manualBookingOpen && (
        <ManualBookingModal
          services={manualBookingServices}
          groupHeaders={manualBookingGroupHeaders}
          onClose={() => setManualBookingOpen(false)}
          onSuccess={() => {
            setBookingToast('Appointment booked successfully.');
            router.refresh();
          }}
        />
      )}

      {slotAction !== null && (
        <CalendarSlotActionDialog
          action={slotAction}
          services={manualBookingServices}
          groupHeaders={manualBookingGroupHeaders}
          onClose={() => setSlotAction(null)}
          onBooked={() => {
            setBookingToast('Appointment booked successfully.');
            router.refresh();
            setSlotAction(null);
          }}
          onBlocked={(infoMessage) => {
            if (infoMessage) setBookingToast(infoMessage);
            router.refresh();
            setSlotAction(null);
          }}
        />
      )}

      {bookingToast && (
        <div
          role="status"
          className="fixed top-4 left-1/2 z-[80] max-w-md -translate-x-1/2 rounded-full border border-emerald-200 bg-emerald-50 px-5 py-2.5 text-sm text-emerald-900 shadow-lg"
        >
          <div className="flex items-center gap-3">
            <span>{bookingToast}</span>
            <button
              type="button"
              onClick={() => setBookingToast(null)}
              className="text-emerald-700 underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 4-segment pill toggle. Active option uses the same stone-900 surface
 * as the sign-in button so the dashboard's visual language stays
 * consistent across auth and authenticated screens.
 */
function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-stone-200 bg-white p-0.5">
      <ToggleButton
        active={view === 'list'}
        onClick={() => onChange('list')}
        icon={<List className="h-3 w-3" />}
        label="List"
      />
      <ToggleButton
        active={view === '3day'}
        onClick={() => onChange('3day')}
        icon={<Columns3 className="h-3 w-3" />}
        label="3 Day"
      />
      <ToggleButton
        active={view === 'week'}
        onClick={() => onChange('week')}
        icon={<CalendarDays className="h-3 w-3" />}
        label="Week"
      />
      <ToggleButton
        active={view === 'month'}
        onClick={() => onChange('month')}
        icon={<Calendar className="h-3 w-3" />}
        label="Month"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium tracking-wide transition-colors ${
        active
          ? 'bg-stone-900 text-stone-50'
          : 'text-stone-600 hover:text-stone-900'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Sub-header showing the visible date-window and prev/today/next nav.
 * Only rendered when a TimeGrid view is active.
 *
 * Step size:
 *   - Week view: ±1 calendar week (anchor day is irrelevant — the
 *     TimeGrid always snaps to the Sun..Sat containing currentDate).
 *   - 3-Day view: ±3 days (paginates cleanly without overlap).
 */
function DateNav({
  view,
  currentDate,
  onChange,
}: {
  view: ViewMode;
  currentDate: Date;
  onChange: (d: Date) => void;
}) {
  const isWeek = view === 'week';
  const daysInView = isWeek ? 7 : 3;
  const prev = () =>
    onChange(isWeek ? subWeeks(currentDate, 1) : subDays(currentDate, 3));
  const next = () =>
    onChange(isWeek ? addWeeks(currentDate, 1) : addDays(currentDate, 3));
  const today = () => onChange(calendarDayUtcNoon(todayStudioDateKey()));

  // Compute the visible range for the label, matching TimeGrid's
  // America/Denver anchoring so the label always says what's on screen.
  const anchorKey = studioDateKey(currentDate) || todayStudioDateKey();
  const rangeStartKey = isWeek
    ? addStudioCalendarDays(anchorKey, -studioWeekdaySun0(anchorKey))
    : anchorKey;
  const rangeEndKey = addStudioCalendarDays(rangeStartKey, daysInView - 1);
  const sameMonth = rangeStartKey.slice(0, 7) === rangeEndKey.slice(0, 7);
  const rangeLabel = sameMonth
    ? `${formatStudioNavDay(rangeStartKey)} – ${Number(rangeEndKey.slice(8, 10))}, ${rangeEndKey.slice(0, 4)}`
    : `${formatStudioNavDay(rangeStartKey)} – ${formatStudioNavDay(rangeEndKey, { includeYear: true })}`;

  return (
    <div className="flex items-center justify-between border-b border-stone-200 bg-[#FAF9F6]/95 px-6 py-3 backdrop-blur-sm">
      <h2 className="font-serif text-lg text-stone-900">{rangeLabel}</h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={prev}
          aria-label={isWeek ? 'Previous week' : 'Previous 3 days'}
          className="rounded-full border border-stone-200 bg-white p-1.5 text-stone-700 transition-colors hover:bg-stone-100"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={today}
          className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
        >
          Today
        </button>
        <button
          type="button"
          onClick={next}
          aria-label={isWeek ? 'Next week' : 'Next 3 days'}
          className="rounded-full border border-stone-200 bg-white p-1.5 text-stone-700 transition-colors hover:bg-stone-100"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
