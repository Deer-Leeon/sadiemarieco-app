/**
 * POST /api/qstash/admin-booking-push
 *
 * Retry remaining APNs tokens after a 5xx / timeout on the first send.
 * Signature-gated like other QStash workers. Always 200 on logical skips.
 */
import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';

import { loadAdminPushDevices, sendAdminBookingPushToTokens } from '@/lib/admin-booking-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey) {
    console.error(
      '[api/qstash/admin-booking-push] QSTASH_CURRENT_SIGNING_KEY missing'
    );
    return NextResponse.json(
      { error: 'signing_key_not_configured' },
      { status: 500 }
    );
  }

  const signature = req.headers.get('upstash-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  try {
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    });
    const isValid = await receiver.verify({ signature, body: rawBody });
    if (!isValid) {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
  } catch (err) {
    console.error('[api/qstash/admin-booking-push] signature verify failed', {
      error: errorMessage(err),
    });
    return NextResponse.json(
      { error: 'signature_verify_failed' },
      { status: 401 }
    );
  }

  let parsed: {
    tokens?: Array<{
      device_token?: string;
      bundle_id?: string;
      environment?: string;
    }>;
    reloadDevices?: boolean;
    appointmentId?: string | null;
    bookingUid?: string;
    clientName?: string | null;
    serviceName?: string | null;
    bookingTime?: string | null;
  } = {};
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as typeof parsed) : {};
  } catch {
    return NextResponse.json({ ok: true, skipped: 'invalid_json' });
  }

  const bookingUid =
    typeof parsed.bookingUid === 'string' ? parsed.bookingUid.trim() : '';
  let tokens = Array.isArray(parsed.tokens)
    ? parsed.tokens.filter(
        (row): row is {
          device_token: string;
          bundle_id: string;
          environment: string;
        } =>
          typeof row?.device_token === 'string' &&
          typeof row?.bundle_id === 'string' &&
          (row.environment === 'development' || row.environment === 'production')
      )
    : [];

  if (parsed.reloadDevices === true) {
    tokens = await loadAdminPushDevices();
  }

  if (!bookingUid || tokens.length === 0) {
    return NextResponse.json({ ok: true, skipped: 'empty' });
  }

  try {
    const result = await sendAdminBookingPushToTokens({
      tokens,
      appointmentId: parsed.appointmentId ?? null,
      bookingUid,
      clientName: parsed.clientName,
      serviceName: parsed.serviceName,
      bookingTime: parsed.bookingTime,
    });
    if (result.retryable && result.retryable.length > 0 && result.sent === 0) {
      return NextResponse.json(
        { error: 'apns_retryable', retryable: result.retryable.length },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, sent: result.sent });
  } catch (err) {
    console.error('[api/qstash/admin-booking-push] send failed', {
      error: errorMessage(err),
    });
    return NextResponse.json({ error: 'send_failed' }, { status: 500 });
  }
}
