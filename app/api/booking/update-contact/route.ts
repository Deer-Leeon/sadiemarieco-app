/**
 * POST /api/booking/update-contact
 *
 * Update name / phone / email on a still-pending hold. Used when the
 * client goes back from pay-choice to fix a typo without releasing the slot.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import {
  clientPhoneValidationMessage,
  parseClientPhone,
  parseOptionalClientEmail,
} from '@/lib/client-identity';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `booking:update-contact:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookingConfirm,
  });
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const raw = body as {
    calBookingUid?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    name?: unknown;
    phone?: unknown;
    email?: unknown;
  };

  const uid =
    typeof raw.calBookingUid === 'string' ? raw.calBookingUid.trim() : '';
  if (!uid || uid.length > 200) {
    return NextResponse.json(
      { error: 'invalid_cal_booking_uid' },
      { status: 400 }
    );
  }

  const firstName =
    typeof raw.firstName === 'string' ? raw.firstName.trim().slice(0, 80) : '';
  const lastName =
    typeof raw.lastName === 'string' ? raw.lastName.trim().slice(0, 80) : '';
  const combinedName =
    typeof raw.name === 'string' ? raw.name.trim().slice(0, 160) : '';
  const first = firstName || combinedName.split(/\s+/)[0] || '';
  const last =
    lastName ||
    (combinedName.split(/\s+/).length > 1
      ? combinedName.split(/\s+/).slice(1).join(' ')
      : '');
  if (!first) {
    return NextResponse.json(
      { error: 'invalid_name', message: 'Enter your first name.' },
      { status: 400 }
    );
  }

  const parsedPhone = parseClientPhone(
    typeof raw.phone === 'string' ? raw.phone : ''
  );
  if (!parsedPhone) {
    return NextResponse.json(
      {
        error: 'invalid_phone',
        message: clientPhoneValidationMessage(),
      },
      { status: 400 }
    );
  }

  const email = parseOptionalClientEmail(
    typeof raw.email === 'string' ? raw.email : ''
  );

  try {
    const { rowCount } = await sql`
      UPDATE appointments
      SET
        client_first_name = ${first},
        client_last_name = ${last || first},
        client_phone = ${parsedPhone.digits},
        client_email = ${email}
      WHERE cal_event_id = ${uid}
        AND status = 'pending'
    `;
    if ((rowCount ?? 0) === 0) {
      return NextResponse.json(
        {
          error: 'hold_not_pending',
          message: 'This booking can no longer be edited.',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      name: [first, last].filter(Boolean).join(' ').trim(),
      email: email || '',
    });
  } catch (err) {
    console.error('[api/booking/update-contact] failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'update_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
