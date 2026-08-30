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
  ensureUpcomingAppointmentSmsReminders: () => Promise<{
    scanned: number;
    scheduled: number;
    failed: number;
    failures: Array<{ bookingUid: string; error: string }>;
  }>;
  rescheduleAppointmentReminderEmails: (
    bookingUid: string,
  ) => Promise<Record<string, unknown>>;
  notifyAdminAppointmentStatusSms: (args: {
    kind: 'admin_cancel' | 'no_show' | 'no_show_charged';
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName: string | null;
    bookingTime: string | null;
    bookingUid?: string | null;
    amountCents?: number | null;
  }) => Promise<Record<string, unknown>>;
  notifyAppointmentRescheduled: (args: {
    bookingUid: string;
    bookingTime: string | null;
    clientPhone: string | null;
    serviceName: string | null;
    smsOptIn: boolean | null | undefined;
    scheduleSmsReminders?: boolean;
    endTime?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyLateCancelFeeSms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName: string | null;
    bookingTime: string | null;
    bookingUid?: string | null;
    amountCents?: number;
  }) => Promise<Record<string, unknown>>;
  notifyClientCancelEarlySms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName: string | null;
    bookingTime: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyClientCancelLateNoFeeSms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName: string | null;
    bookingTime: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyCheckoutAbandonedSms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName: string | null;
    bookingTime: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyFeedbackDayAfterSms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    firstName?: string | null;
    serviceName?: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyReviewRequestSms: (args: {
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    firstName?: string | null;
    serviceName?: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
  scheduleReviewRequestSms: (
    bookingUid: string,
    opts?: {
      bookingTime?: string | null;
      endTime?: string | null;
      force?: boolean;
    }
  ) => Promise<{ scheduled: boolean; reason?: string; messageId?: unknown }>;
  scheduleReviewRequestForClient: (
    clientId: string
  ) => Promise<{ scheduled: boolean; reason?: string; messageId?: unknown }>;
  fulfillReviewRequestForBooking: (args: {
    bookingUid: string;
    expectedBookingTime?: string | null;
  }) => Promise<Record<string, unknown>>;
  notifyFeeFreePassSms: (args: {
    kind:
      | 'no_show_free_pass_used'
      | 'late_change_free_pass_used'
      | 'no_show_free_pass_granted'
      | 'late_change_free_pass_granted';
    clientPhone: string | null;
    smsOptIn: boolean | null | undefined;
    serviceName?: string | null;
    bookingTime?: string | null;
    bookingUid?: string | null;
  }) => Promise<Record<string, unknown>>;
};

export const notifyBookingConfirmed = impl.notifyBookingConfirmed;
export const ensureUpcomingAppointmentSmsReminders =
  impl.ensureUpcomingAppointmentSmsReminders;
export const rescheduleAppointmentReminderEmails =
  impl.rescheduleAppointmentReminderEmails;
export const notifyAdminAppointmentStatusSms =
  impl.notifyAdminAppointmentStatusSms;
export const notifyAppointmentRescheduled = impl.notifyAppointmentRescheduled;
export const notifyLateCancelFeeSms = impl.notifyLateCancelFeeSms;
export const notifyClientCancelEarlySms = impl.notifyClientCancelEarlySms;
export const notifyClientCancelLateNoFeeSms =
  impl.notifyClientCancelLateNoFeeSms;
export const notifyCheckoutAbandonedSms = impl.notifyCheckoutAbandonedSms;
export const notifyFeedbackDayAfterSms = impl.notifyFeedbackDayAfterSms;
export const notifyReviewRequestSms = impl.notifyReviewRequestSms;
export const scheduleReviewRequestSms = impl.scheduleReviewRequestSms;
export const scheduleReviewRequestForClient =
  impl.scheduleReviewRequestForClient;
export const fulfillReviewRequestForBooking =
  impl.fulfillReviewRequestForBooking;
export const notifyFeeFreePassSms = impl.notifyFeeFreePassSms;
