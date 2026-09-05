'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

import AppointmentHistoryList from '../AppointmentHistoryList';
import type { Appointment } from '../types';

interface Props {
  appointments: Appointment[];
  open: boolean;
  onClose: () => void;
  onSelect: (appointment: Appointment) => void;
  /** Skip ESC while a stacked appointment modal is on top. */
  captureEscape?: boolean;
}

/**
 * Centered past-history overlay matching the iOS client-profile popup:
 * blurs the profile behind it, solid card, day-grouped visits with nested extras.
 */
export default function PastAppointmentsPopup({
  appointments,
  open,
  onClose,
  onSelect,
  captureEscape = true,
}: Props) {
  useEffect(() => {
    if (!open || !captureEscape) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, captureEscape, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-65 flex items-center justify-center bg-stone-900/40 p-5 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[calc(100vh-48px)] w-full max-w-130 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="past-appointments-title"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <h2
            id="past-appointments-title"
            className="text-xs font-medium text-stone-700"
          >
            Past appointments
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-700 transition-colors hover:bg-stone-200"
          >
            <X className="h-3 w-3 stroke-[2.5]" />
          </button>
        </div>
        <div className="h-px bg-stone-200" />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
          <AppointmentHistoryList
            appointments={appointments}
            dayOrder="desc"
            onSelect={onSelect}
          />
        </div>
      </div>
    </div>
  );
}
