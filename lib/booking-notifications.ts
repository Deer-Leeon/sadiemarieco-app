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
    clientId?: string | null;
    clientEmail?: string | null;
    endTime?: string | null;
    skipIfAlreadySent?: boolean;
    smsOptIn?: boolean | null;
  }) => Promise<Record<string, unknown>>;
  rescheduleAppointmentReminderEmails: (
    bookingUid: string,
  ) => Promise<Record<string, unknown>>;
};

export const notifyBookingConfirmed = impl.notifyBookingConfirmed;
export const rescheduleAppointmentReminderEmails =
  impl.rescheduleAppointmentReminderEmails;
