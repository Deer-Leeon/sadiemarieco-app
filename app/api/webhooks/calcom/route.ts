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
 *   - RESEND_FROM_EMAIL (defaults to Sadie Marie <bookings@sadiemarie.co>)
 *   - PUBLIC_BASE_URL (fallback cancel/manage link base)
 */

import { NextRequest, NextResponse } from 'next/server';

import { sendBookingConfirmationEmail } from '@/lib/send-booking-confirmation-email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://www.sadiemarie.co';

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

function resolveCancelUrl(payload: Record<string, unknown>): string {
  const direct = unwrap(payload.cancel_url) || unwrap(payload.cancelUrl);
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
    console.log('[api/webhooks/calcom] received', { triggerEvent });

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
    const startTimeRaw = unwrap(payload.startTime) || unwrap(payload.start);
    const bookingUid = unwrap(payload.uid);

    if (!clientEmail || !startTimeRaw) {
      console.warn('[api/webhooks/calcom] missing attendee email or startTime', {
        bookingUid,
        hasEmail: Boolean(clientEmail),
        hasStartTime: Boolean(startTimeRaw),
      });
      return NextResponse.json({ ok: true, skipped: 'missing_fields' });
    }

    const cancelUrl = resolveCancelUrl(payload);
    const emailResult = await sendBookingConfirmationEmail({
      clientName,
      clientEmail,
      serviceName,
      startTime: startTimeRaw,
      cancelUrl,
      bookingUid,
    });

    if (!emailResult.ok) {
      console.error('[api/webhooks/calcom] email not sent', {
        bookingUid,
        ...emailResult,
      });
    }

    return NextResponse.json({ ok: true, email: emailResult });
  } catch (err) {
    console.error('[api/webhooks/calcom] handler error', err);
    return NextResponse.json({ ok: true });
  }
}
