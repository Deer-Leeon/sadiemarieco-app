'use client';

import { useState } from 'react';
import {
  addDays,
  addWeeks,
  format,
  startOfWeek,
  subDays,
  subWeeks,
} from 'date-fns';
import {
  Calendar,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  List,
} from 'lucide-react';

import type { Appointment, ViewMode } from './types';
import AdminHeader from './AdminHeader';
import AdminSectionTabs from './AdminSectionTabs';
import ListView from './ListView';
import CalendarView from './CalendarView';
import TimeGrid from './TimeGrid';
import SingleDayModal from './SingleDayModal';
import AppointmentModal from './AppointmentModal';

interface Props {
  appointments: Appointment[];
  dbError: string | null;
  displayName: string;
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
  appointments,
  dbError,
  displayName,
}: Props) {
  // Default to the continuous-scroll month calendar. It surfaces both
  // the highest density of context (a full month of bookings at a
  // glance) and lands the user on "today" via the auto-scroll in
  // CalendarView — the closest single-view equivalent of the old
  // homepage feeling.
  const [view, setView] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
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

  const showDateNav = view === '3day' || view === 'week';

  return (
    <div className="h-screen w-full overflow-hidden flex flex-col bg-[#FAF9F6] text-stone-900 font-sans">
      <AdminHeader title="Bookings" displayName={displayName}>
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
          appointments.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-stone-500">No bookings yet.</p>
            </div>
          ) : (
            <ListView appointments={appointments} />
          )
        ) : view === 'month' ? (
          <CalendarView
            appointments={appointments}
            onAppointmentClick={setSelectedAppointment}
          />
        ) : view === '3day' ? (
          <TimeGrid
            appointments={appointments}
            currentDate={currentDate}
            daysToShow={3}
            onDayClick={setModalDate}
            onAppointmentClick={setSelectedAppointment}
          />
        ) : (
          <TimeGrid
            appointments={appointments}
            currentDate={currentDate}
            daysToShow={7}
            onDayClick={setModalDate}
            onAppointmentClick={setSelectedAppointment}
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
          appointments={appointments}
          initialDate={modalDate}
          onClose={() => setModalDate(null)}
          onAppointmentClick={setSelectedAppointment}
        />
      )}
      {selectedAppointment !== null && (
        <AppointmentModal
          appointment={selectedAppointment}
          onClose={() => setSelectedAppointment(null)}
        />
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
  const today = () => onChange(new Date());

  // Compute the visible range for the label, matching TimeGrid's
  // anchoring rules so the label always says exactly what's on screen.
  const rangeStart = isWeek
    ? startOfWeek(currentDate, { weekStartsOn: 0 })
    : currentDate;
  const rangeEnd = addDays(rangeStart, daysInView - 1);
  const sameMonth = format(rangeStart, 'yyyy-MM') === format(rangeEnd, 'yyyy-MM');
  const rangeLabel = sameMonth
    ? `${format(rangeStart, 'MMM d')} – ${format(rangeEnd, 'd, yyyy')}`
    : `${format(rangeStart, 'MMM d')} – ${format(rangeEnd, 'MMM d, yyyy')}`;

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
