import type { ReminderServiceKind } from '@/lib/appointment-service-lookup';
import {
  EMAIL_TEMPLATE_META,
  reminderEmailTemplateKey,
  reminderSoonTimePhrase,
  renderEmailTemplate,
} from '@/lib/email-message-templates';
import { cleanEmailServiceTitle } from '@/lib/email-templates';

export type ReminderEmailTiming = 'lead' | '1h' | 'immediate';

/**
 * Sync reminder body from in-code defaults (no DB).
 * Prefer resolveEmailCopy at send time so admin edits apply.
 */
export function buildReminderBodyCopy(args: {
  serviceName: string;
  kind: ReminderServiceKind;
  timing: ReminderEmailTiming;
  minutesUntil?: number;
}): string {
  const service = cleanEmailServiceTitle(args.serviceName);
  const key = reminderEmailTemplateKey(args.kind, args.timing);
  const vars: Record<string, string> = { service };
  if (args.timing === 'immediate') {
    vars.timePhrase = reminderSoonTimePhrase(args.kind, args.minutesUntil);
  }
  return renderEmailTemplate(EMAIL_TEMPLATE_META[key].defaultBody, vars);
}

export function reminderEmailSubject(serviceName: string): string {
  const service = cleanEmailServiceTitle(serviceName) || 'Your appointment';
  return `Reminder: ${service} with Sadie Marie`;
}
