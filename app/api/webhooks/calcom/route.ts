/**
 * POST /api/webhooks/calcom
 *
 * Optional Cal.com subscriber for confirmation email only. Email also sends
 * from /api/webhook on BOOKING_CREATED — disable this webhook in Cal.com if
 * you only need one path (recommended).
 *
 * Duplicate sends are deduped via webhook_events (`{uid}:email`).
 */

import { NextRequest, NextResponse } from 'next/server';

import { resolveBookingServiceName } from '@/lib/resolve-booking-service-name';
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
    if (triggerEvent && triggerEvent !== 'BOOKING_CREATED') {
      return NextResponse.json({ ok: true, skipped: 'ignored_event' });
    }

    const payload = body.payload ?? {};
    const metadata =
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as Record<string, unknown>)
        : {};
    if (unwrap(metadata.manual_admin_booking) === 'true') {
      return NextResponse.json({
        ok: true,
        skipped: 'manual_admin_notifications_deferred',
      });
    }

    const attendees = payload.attendees;
    const attendee =
      Array.isArray(attendees) && attendees[0] && typeof attendees[0] === 'object'
        ? (attendees[0] as Record<string, unknown>)
        : {};

    const clientName = unwrap(attendee.name) || 'there';
    const clientEmail = unwrap(attendee.email);
    const serviceName = resolveBookingServiceName(payload);
    const startTimeRaw = unwrap(payload.startTime) || unwrap(payload.start);
    const bookingUid = unwrap(payload.uid);

    if (!clientEmail || !startTimeRaw) {
      return NextResponse.json({ ok: true, skipped: 'missing_fields' });
    }

    const emailResult = await sendBookingConfirmationEmail({
      clientName,
      clientEmail,
      serviceName,
      startTime: startTimeRaw,
      cancelUrl: resolveCancelUrl(payload),
      bookingUid,
    });

    return NextResponse.json({ ok: true, email: emailResult });
  } catch (err) {
    console.error('[api/webhooks/calcom] handler error', err);
    return NextResponse.json({ ok: true });
  }
}
