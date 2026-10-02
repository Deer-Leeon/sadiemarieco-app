/**
 * POST /api/booking/attempt
 *
 * Public step beacon for the phone booker and the desktop drawer.
 * Body: { attemptId, surface, step?, service?, leave? }
 * No Clerk gate. Junk steps are ignored. Never stores contact details.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  cleanAttemptService,
  leaveBookingAttempt,
  parseAttemptId,
  parseAttemptStep,
  parseAttemptSurface,
  parseCheckoutMethod,
  recordBookingAttempt,
} from '@/lib/booking-attempt';
import {
  clientIpFromRequest,
  RATE_LIMITS,
  rejectUnlessRateAllowed,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function readBody(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limited = await rejectUnlessRateAllowed({
    key: `booking:attempt:${clientIpFromRequest(req)}`,
    ...RATE_LIMITS.bookingAttempt,
  });
  if (limited) return limited;

  const raw = await readBody(req);
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const body = raw as {
    attemptId?: unknown;
    surface?: unknown;
    step?: unknown;
    service?: unknown;
    leave?: unknown;
    checkoutMethod?: unknown;
  };

  const attemptId = parseAttemptId(body.attemptId);
  if (!attemptId) {
    return NextResponse.json({ error: 'invalid_attempt' }, { status: 400 });
  }

  const leave = body.leave === true;
  const step = parseAttemptStep(body.step);
  const surface = parseAttemptSurface(body.surface);

  if (!leave && !step) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    if (step && surface) {
      await recordBookingAttempt({
        attemptId,
        surface,
        step,
        service: cleanAttemptService(body.service),
        checkoutMethod: parseCheckoutMethod(body.checkoutMethod),
      });
    } else if (!leave) {
      return NextResponse.json({ ok: true, ignored: true });
    }
    if (leave) {
      await leaveBookingAttempt(attemptId);
    }
  } catch (err) {
    console.warn('[api/booking/attempt] write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  return NextResponse.json({ ok: true });
}
