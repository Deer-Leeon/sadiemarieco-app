/**
 * TypeScript wrapper for admin iOS APNs booking alerts.
 */

export type AdminPushKind = 'confirmed' | 'rescheduled' | 'canceled';
export type AdminPushSource = 'client' | 'admin';

type PushArgs = {
  kind?: AdminPushKind;
  source?: AdminPushSource;
  bookingUid: string;
  bookingTime?: string | Date | null;
  clientName?: string | null;
  serviceName?: string | null;
  appointmentId?: string | null;
  skipIfAlreadySent?: boolean;
};

type SendArgs = {
  tokens: Array<{
    device_token: string;
    bundle_id: string;
    environment: string;
  }>;
  kind?: AdminPushKind;
  source?: AdminPushSource;
  appointmentId?: string | null;
  bookingUid: string;
  clientName?: string | null;
  serviceName?: string | null;
  bookingTime?: string | Date | null;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./admin-booking-push.js') as {
  ensureAdminPushDevicesTable: () => Promise<void>;
  notifyAdminAppointmentPush: (
    args: PushArgs
  ) => Promise<Record<string, unknown>>;
  notifyAdminBookingConfirmed: (
    args: PushArgs
  ) => Promise<Record<string, unknown>>;
  sendAdminBookingPushToTokens: (
    args: SendArgs
  ) => Promise<{ ok: boolean; sent: number; retryable?: unknown[] }>;
  loadDevices: () => Promise<
    Array<{
      device_token: string;
      bundle_id: string;
      environment: string;
    }>
  >;
};

export const ensureAdminPushDevicesTable = impl.ensureAdminPushDevicesTable;
export const notifyAdminAppointmentPush = impl.notifyAdminAppointmentPush;
export const notifyAdminBookingConfirmed = impl.notifyAdminBookingConfirmed;
export const sendAdminBookingPushToTokens = impl.sendAdminBookingPushToTokens;
export const loadAdminPushDevices = impl.loadDevices;
