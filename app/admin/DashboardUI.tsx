'use client';

import { useState } from 'react';
import { SignOutButton } from '@clerk/nextjs';
import { Calendar, List, LogOut } from 'lucide-react';

import type { Appointment, ViewMode } from './types';
import ListView from './ListView';
import CalendarView from './CalendarView';

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
 *   - Main content area is `flex-1 overflow-hidden`. ONLY the inner
 *     list/calendar views are allowed to introduce their own scroll
 *     containers, never this outer main.
 */
export default function DashboardUI({
  appointments,
  dbError,
  displayName,
}: Props) {
  const [view, setView] = useState<ViewMode>('list');

  return (
    <div className="h-screen w-full overflow-hidden flex flex-col bg-[#FAF9F6] text-stone-900 font-sans">
      <header className="flex flex-col gap-3 border-b border-stone-200 bg-[#FAF9F6]/95 px-6 py-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
            Sadie Marie · Admin
          </p>
          <h1 className="font-serif text-2xl leading-tight text-stone-900">
            Bookings
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <ViewToggle view={view} onChange={setView} />
          <span className="hidden text-sm text-stone-500 md:inline">
            {displayName}
          </span>
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </SignOutButton>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {dbError ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Could not load bookings: {dbError}
            </div>
          </div>
        ) : appointments.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-stone-500">No bookings yet.</p>
          </div>
        ) : view === 'list' ? (
          <ListView appointments={appointments} />
        ) : (
          <CalendarView appointments={appointments} />
        )}
      </main>
    </div>
  );
}

/**
 * Pill-shaped segmented control. Active option has solid dark-stone
 * background; inactive options are transparent text-only buttons. Pure
 * CSS — no portal, no library.
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
        active={view === 'calendar'}
        onClick={() => onChange('calendar')}
        icon={<Calendar className="h-3 w-3" />}
        label="Calendar"
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
