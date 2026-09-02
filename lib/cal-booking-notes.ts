// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./cal-booking-notes.js') as {
  extractCalBookingNotes: (
    payload: Record<string, unknown> | null | undefined
  ) => string | null;
  normalizeStoredBookingNotes: (raw: unknown) => string | null;
  clientBookingNotesForDisplay: (
    raw: unknown,
    serviceDescription?: unknown
  ) => string | null;
  clampNotes: (text: string | null | undefined) => string | null;
};

export const extractCalBookingNotes = impl.extractCalBookingNotes;
export const normalizeStoredBookingNotes = impl.normalizeStoredBookingNotes;
export const clientBookingNotesForDisplay = impl.clientBookingNotesForDisplay;
export const clampNotes = impl.clampNotes;
