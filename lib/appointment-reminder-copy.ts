import type { ReminderServiceKind } from '@/lib/appointment-service-lookup';
import {
  EMAIL_TEMPLATE_META,
  reminderEmailTemplateKey,
  renderEmailTemplate,
} from '@/lib/email-message-templates';
import { cleanEmailServiceTitle } from '@/lib/email-templates';

export type ReminderEmailTiming = 'lead';

/**
 * Sync reminder body from in-code defaults (no DB).
 * Prefer resolveEmailCopy at send time so admin edits apply.
 */
export function buildReminderBodyCopy(args: {
  serviceName: string;
  kind: ReminderServiceKind;
  timing: ReminderEmailTiming;
}): string {
  const service = cleanEmailServiceTitle(args.serviceName);
  const key = reminderEmailTemplateKey(args.kind, args.timing);
  return renderEmailTemplate(EMAIL_TEMPLATE_META[key].defaultBody, { service });
}

export function reminderEmailSubject(serviceName: string): string {
  const service = cleanEmailServiceTitle(serviceName) || 'Your appointment';
  return `Reminder: ${service} with Sadie Marie`;
}
