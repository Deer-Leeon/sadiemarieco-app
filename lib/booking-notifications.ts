/**
 * TypeScript wrapper for booking confirmation notifications.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./booking-notifications.js') as {
  notifyBookingConfirmed: (args: {
    bookingUid: string;
    bookingTime: string | null;
    clientPhone: string;
    clientName: string;
    serviceName: string;
    skipIfAlreadySent?: boolean;
  }) => Promise<Record<string, unknown>>;
};

export const notifyBookingConfirmed = impl.notifyBookingConfirmed;
