/**
 * Typed façade over lib/sms-outbound-log.js.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./sms-outbound-log.js') as {
  normalizeTemplateKey: (logLabel: string | null | undefined) => string;
  recordOutboundSms: (args: {
    logLabel?: string | null;
    templateKey?: string | null;
    body: string;
    toE164: string;
    bookingUid?: string | null;
    twilioSid?: string | null;
  }) => Promise<void>;
  listOutboundSms: (args?: {
    limit?: number;
    before?: string | null;
  }) => Promise<SmsOutboundLogRow[]>;
};

export type SmsOutboundLogRow = {
  id: string;
  created_at: Date | string;
  template_key: string;
  body: string;
  to_e164: string;
  client_id: string | null;
  client_name: string | null;
  booking_uid: string | null;
  twilio_sid: string | null;
};

export const normalizeTemplateKey = impl.normalizeTemplateKey;
export const recordOutboundSms = impl.recordOutboundSms;
export const listOutboundSms = impl.listOutboundSms;
