/**
 * Typed façade over lib/admin-reschedule-intent.js.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./admin-reschedule-intent.js') as {
  markAdminRescheduleIntent: (appointmentId: string) => Promise<void>;
  consumeAdminRescheduleIntent: (appointmentId: string) => Promise<boolean>;
};

export const markAdminRescheduleIntent = impl.markAdminRescheduleIntent;
export const consumeAdminRescheduleIntent = impl.consumeAdminRescheduleIntent;
