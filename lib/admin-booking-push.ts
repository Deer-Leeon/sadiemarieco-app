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
  requestHost?: string | null;
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
  requestHost?: string | null;
  attempt?: number;
};

export type AdminPushRetryResult = {
  ok: boolean;
  sent: number;
  /** HTTP status the QStash worker route should answer with. */
  status: number;
  skipped?: string;
  retryScheduled?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./admin-booking-push.js') as {
  MAX_ATTEMPTS: number;
  ensureAdminPushDevicesTable: () => Promise<void>;
  ensureAdminPushLogTables: () => Promise<void>;
  notifyAdminAppointmentPush: (
    args: PushArgs
  ) => Promise<Record<string, unknown>>;
  notifyAdminBookingConfirmed: (
    args: PushArgs
  ) => Promise<Record<string, unknown>>;
  sendAdminBookingPushToTokens: (
    args: SendArgs
  ) => Promise<{
    ok: boolean;
    sent: number;
    retryable: unknown[];
    invalid: number;
    skipped?: string;
  }>;
  runAdminPushRetry: (args: {
    body: unknown;
    requestHost?: string | null;
  }) => Promise<AdminPushRetryResult>;
  loadDevices: () => Promise<
    Array<{
      device_token: string;
      bundle_id: string;
      environment: string;
    }>
  >;
};

export const ADMIN_PUSH_MAX_ATTEMPTS = impl.MAX_ATTEMPTS;
export const ensureAdminPushDevicesTable = impl.ensureAdminPushDevicesTable;
export const ensureAdminPushLogTables = impl.ensureAdminPushLogTables;
export const notifyAdminAppointmentPush = impl.notifyAdminAppointmentPush;
export const notifyAdminBookingConfirmed = impl.notifyAdminBookingConfirmed;
export const sendAdminBookingPushToTokens = impl.sendAdminBookingPushToTokens;
export const runAdminPushRetry = impl.runAdminPushRetry;
export const loadAdminPushDevices = impl.loadDevices;
