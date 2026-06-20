import { Resend } from 'resend';

import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { generateConfirmationHtml } from '@/lib/email-templates';

const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || 'Sadie Marie <bookings@sadiemarie.co>';

function maskEmail(email: string): string {
  if (!email.includes('@')) return '[redacted]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** e.g. "Saturday, June 20 at 10:00am" */
export function formatBookingStartTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const datePart = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: STUDIO_TIMEZONE,
  }).format(date);

  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: STUDIO_TIMEZONE,
  })
    .format(date)
    .replace(/\s?AM$/i, 'am')
    .replace(/\s?PM$/i, 'pm');

  return `${datePart} at ${timePart}`;
}

export async function sendBookingConfirmationEmail(args: {
  clientName: string;
  clientEmail: string;
  serviceName: string;
  startTime: string;
  cancelUrl: string;
  bookingUid?: string;
}): Promise<{ ok: boolean; skipped?: string; error?: string; id?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[booking-confirmation-email] RESEND_API_KEY is not configured');
    return { ok: false, skipped: 'email_not_configured' };
  }

  const clientEmail = args.clientEmail.trim().toLowerCase();
  if (!clientEmail || !clientEmail.includes('@')) {
    return { ok: false, skipped: 'no_email' };
  }

  const formattedStart = formatBookingStartTime(args.startTime);
  const html = generateConfirmationHtml(
    args.clientName,
    args.serviceName,
    formattedStart,
    args.cancelUrl,
  );

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: clientEmail,
    subject: `Confirmation: Your Session with Sadie Marie, ${args.clientName}!`,
    html,
  });

  if (error) {
    console.error('[booking-confirmation-email] Resend send failed', {
      bookingUid: args.bookingUid,
      to: maskEmail(clientEmail),
      error,
    });
    return { ok: false, error: error.message };
  }

  console.log('[booking-confirmation-email] sent', {
    bookingUid: args.bookingUid,
    to: maskEmail(clientEmail),
    id: data?.id,
  });

  return { ok: true, id: data?.id };
}
