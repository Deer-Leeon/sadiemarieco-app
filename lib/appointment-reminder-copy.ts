import type { ReminderServiceKind } from '@/lib/appointment-service-lookup';

export type ReminderEmailTiming = 'lead' | '1h' | 'immediate';

export function buildReminderBodyCopy(args: {
  serviceName: string;
  kind: ReminderServiceKind;
  timing: ReminderEmailTiming;
  minutesUntil?: number;
}): string {
  const service = args.serviceName.trim() || 'appointment';

  if (args.timing === 'lead') {
    if (args.kind === 'lashes') {
      return `Your appointment for ${service} is tomorrow! Please come with clean lashes and no eye makeup. Please refrain from drinking caffeine for at least 4-6 hours before your appointment as it can cause fluttery eyelids. Feel free to bring earbuds with you. I'm so excited to see you!`;
    }
    return `Your appointment for ${service} is in 2 days! Please come with clean brows and no makeup. Avoid any products containing retinol or tretinoin until after your appointment. Feel free to bring earbuds with you. I'm so excited to see you!`;
  }

  if (args.timing === '1h') {
    if (args.kind === 'lashes') {
      return `Your appointment for ${service} is in one hour! Please come with clean lashes and no eye makeup. Feel free to bring earbuds with you. I'm so excited to see you!`;
    }
    return `Your appointment for ${service} is in 1 hour! Please come with clean brows and no makeup. Feel free to bring earbuds with you. I'm so excited to see you!`;
  }

  const minutes = Math.max(1, Math.round(args.minutesUntil ?? 1));
  const timePhrase =
    minutes >= 55
      ? args.kind === 'lashes'
        ? 'in one hour'
        : 'in 1 hour'
      : `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  if (args.kind === 'lashes') {
    return `Your appointment for ${service} is ${timePhrase}! Please come with clean lashes and no eye makeup. Feel free to bring earbuds with you. I'm so excited to see you!`;
  }
  return `Your appointment for ${service} is ${timePhrase}! Please come with clean brows and no makeup. Feel free to bring earbuds with you. I'm so excited to see you!`;
}

export function reminderEmailSubject(serviceName: string): string {
  const service = serviceName.trim() || 'Your appointment';
  return `Reminder: ${service} with Sadie Marie`;
}
