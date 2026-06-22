// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./cal-booking-notes.js') as {
  extractCalBookingNotes: (
    payload: Record<string, unknown> | null | undefined,
  ) => string | null;
};

export const extractCalBookingNotes = impl.extractCalBookingNotes;
