'use client';

import { useState } from 'react';

import BlockTimeDialog from './BlockTimeDialog';
import ManualBookingModal from './components/ManualBookingModal';
import type {
  ManualBookingServiceGroupHeader,
  ManualBookingServiceOption,
} from './components/manual-booking-utils';

export type CalendarSlotAction = {
  date: Date;
  hour: number;
};

type SlotActionMode = 'book' | 'block';

function SlotActionModeToggle({
  mode,
  onChange,
}: {
  mode: SlotActionMode;
  onChange: (mode: SlotActionMode) => void;
}) {
  const btn = (id: SlotActionMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(id)}
      aria-pressed={mode === id}
      className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] transition-colors ${
        mode === id
          ? 'bg-stone-900 text-stone-50'
          : 'text-stone-600 hover:text-stone-900'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="inline-flex items-center rounded-full border border-stone-200 bg-white p-0.5">
      {btn('book', 'Book')}
      {btn('block', 'Block time')}
    </div>
  );
}

interface Props {
  action: CalendarSlotAction;
  services: ManualBookingServiceOption[];
  groupHeaders: ManualBookingServiceGroupHeader[];
  onClose: () => void;
  onBooked: () => void;
  onBlocked: (infoMessage?: string) => void;
}

export default function CalendarSlotActionDialog({
  action,
  services,
  groupHeaders,
  onClose,
  onBooked,
  onBlocked,
}: Props) {
  const [mode, setMode] = useState<SlotActionMode>('book');
  const modeSwitch = <SlotActionModeToggle mode={mode} onChange={setMode} />;

  if (mode === 'block') {
    return (
      <BlockTimeDialog
        activeDate={action.date}
        initialHour={action.hour}
        onClose={onClose}
        onCreated={onBlocked}
        modeSwitch={modeSwitch}
      />
    );
  }

  return (
    <ManualBookingModal
      services={services}
      groupHeaders={groupHeaders}
      seedDate={action.date}
      seedHour={action.hour}
      modeSwitch={modeSwitch}
      onClose={onClose}
      onSuccess={onBooked}
    />
  );
}
