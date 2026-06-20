/**
 * POST /api/webhooks/calcom
 *
 * Receives Cal.com webhook events and sends a branded HTML confirmation
 * email to the booking attendee via Resend. Intended as a dedicated
 * subscriber URL in Cal.com (separate from /api/webhook, which handles
 * Postgres upserts, SMS, and QStash).
 *
 * Required environment variables:
 *   - RESEND_API_KEY
 *
 * Optional:
 *   - RESEND_FROM_EMAIL (defaults to bookings@sadiemarie.co)
 *   - PUBLIC_BASE_URL (fallback cancel/manage link base)
 */

import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

import { STUDIO_TIMEZONE } from '@/lib/cal-config';
import { generateConfirmationHtml } from '@/lib/email-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'bookings@sadiemarie.co';
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

const resend = new Resend(process.env.RESEND_API_KEY);

function unwrap(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const nested = (val as { value?: unknown }).value;
    if (typeof nested === 'string') return nested;
  }
  return String(val);
}

function resolveServiceName(payload: Record<string, unknown>): string {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const shadowName = unwrap(metadata.original_service_name);
  if (shadowName) return shadowName;
  return unwrap(payload.type) || unwrap(payload.title) || 'appointment';
}

/** e.g. "Saturday, June 20 at 10:00am" */
function formatBookingStartTime(iso: string): string {
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

function resolveCancelUrl(payload: Record<string, unknown>): string {
  const direct =
    unwrap(payload.cancel_url) || unwrap(payload.cancelUrl);
  if (direct) return direct;

  const uid = unwrap(payload.uid);
  const base = PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}/manage.html?uid=${encodeURIComponent(uid)}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      triggerEvent?: string;
      payload?: Record<string, unknown>;
    };

    const triggerEvent = body.triggerEvent || '';
    if (triggerEvent && triggerEvent !== 'BOOKING_CREATED') {
      return NextResponse.json({ ok: true, skipped: 'ignored_event' });
    }

    const payload = body.payload ?? {};
    const attendees = payload.attendees;
    const attendee =
      Array.isArray(attendees) && attendees[0] && typeof attendees[0] === 'object'
        ? (attendees[0] as Record<string, unknown>)
        : {};

    const clientName = unwrap(attendee.name) || 'there';
    const clientEmail = unwrap(attendee.email);
    const serviceName = resolveServiceName(payload);
    const startTimeRaw =
      unwrap(payload.startTime) || unwrap(payload.start);

    if (!clientEmail || !startTimeRaw) {
      console.warn('[api/webhooks/calcom] missing attendee email or startTime');
      return NextResponse.json({ ok: true, skipped: 'missing_fields' });
    }

    if (!process.env.RESEND_API_KEY) {
      console.error('[api/webhooks/calcom] RESEND_API_KEY is not configured');
      return NextResponse.json({ ok: true, skipped: 'email_not_configured' });
    }

    const startTime = formatBookingStartTime(startTimeRaw);
    const cancelUrl = resolveCancelUrl(payload);
    const html = generateConfirmationHtml(
      clientName,
      serviceName,
      startTime,
      cancelUrl,
    );

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: clientEmail,
      subject: `Confirmation: Your Session with Sadie Marie, ${clientName}!`,
      html,
    });

    if (error) {
      console.error('[api/webhooks/calcom] Resend send failed', error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/webhooks/calcom] handler error', err);
    return NextResponse.json({ ok: true });
  }
}
