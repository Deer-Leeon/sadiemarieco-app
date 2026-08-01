import { sql } from '@vercel/postgres';
import { Resend } from 'resend';

import { generateConsentRequestHtml } from '@/lib/email-templates';
import { resolveEmailCopy } from '@/lib/email-message-templates';
import { isPlaceholderClientEmail, isValidEmail } from '@/lib/client-identity';

const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || 'Sadie Marie <bookings@sadiemarie.co>';

function maskEmail(email: string): string {
  if (!email.includes('@')) return '[redacted]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Idempotent per booking — prevents duplicate consent emails from parallel paths. */
async function claimConsentEmailSend(
  bookingUid: string | undefined
): Promise<boolean> {
  if (!bookingUid) return true;
  const key = `${bookingUid}:consent-email`;
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${key})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[consent-request-email] idempotency claim failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export async function sendConsentRequestEmail(args: {
  clientName: string;
  clientEmail: string;
  consentUrl: string;
  bookingUid?: string;
}): Promise<{ ok: boolean; skipped?: string; error?: string; id?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[consent-request-email] RESEND_API_KEY is not configured');
    return { ok: false, skipped: 'email_not_configured' };
  }

  const clientEmail = args.clientEmail.trim().toLowerCase();
  if (
    !clientEmail ||
    !isValidEmail(clientEmail) ||
    isPlaceholderClientEmail(clientEmail)
  ) {
    return { ok: false, skipped: 'no_email' };
  }

  const consentUrl = args.consentUrl.trim();
  if (!consentUrl.startsWith('http')) {
    return { ok: false, skipped: 'invalid_consent_url' };
  }

  const claimed = await claimConsentEmailSend(args.bookingUid);
  if (!claimed) {
    console.log('[consent-request-email] duplicate skipped', {
      bookingUid: args.bookingUid,
    });
    return { ok: true, skipped: 'already_sent' };
  }

  const bodyCopy = await resolveEmailCopy('consent_request');
  const html = generateConsentRequestHtml({
    clientName: args.clientName,
    consentUrl,
    bodyCopy,
  });

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: clientEmail,
    subject: 'Please complete your consent form — Sadie Marie',
    html,
  });

  if (error) {
    console.error('[consent-request-email] Resend send failed', {
      bookingUid: args.bookingUid,
      to: maskEmail(clientEmail),
      error,
    });
    return { ok: false, error: error.message };
  }

  console.log('[consent-request-email] sent', {
    bookingUid: args.bookingUid,
    to: maskEmail(clientEmail),
    id: data?.id,
  });

  return { ok: true, id: data?.id };
}
