/**
 * TypeScript wrapper for admin iOS APNs booking alerts.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./admin-booking-push.js') as {
  ensureAdminPushDevicesTable: () => Promise<void>;
  notifyAdminBookingConfirmed: (args: {
    bookingUid: string;
    bookingTime?: string | Date | null;
    clientName?: string | null;
    serviceName?: string | null;
    appointmentId?: string | null;
    skipIfAlreadySent?: boolean;
  }) => Promise<Record<string, unknown>>;
  sendAdminBookingPushToTokens: (args: {
    tokens: Array<{
      device_token: string;
      bundle_id: string;
      environment: string;
    }>;
    appointmentId?: string | null;
    bookingUid: string;
    clientName?: string | null;
    serviceName?: string | null;
    bookingTime?: string | Date | null;
  }) => Promise<{ ok: boolean; sent: number; retryable?: unknown[] }>;
  loadDevices: () => Promise<
    Array<{
      device_token: string;
      bundle_id: string;
      environment: string;
    }>
  >;
};

export const ensureAdminPushDevicesTable = impl.ensureAdminPushDevicesTable;
export const notifyAdminBookingConfirmed = impl.notifyAdminBookingConfirmed;
export const sendAdminBookingPushToTokens = impl.sendAdminBookingPushToTokens;
export const loadAdminPushDevices = impl.loadDevices;
