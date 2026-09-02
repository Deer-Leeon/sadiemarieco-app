/**
 * GET /api/admin/clients/[id]/sms-messages
 *
 * Outbound studio texts for one client. Pulls missing rows from Twilio
 * first (best-effort — Twilio only retains Message records for a limited
 * window), then returns the local ledger newest first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import {
  displayTitleForTemplateKey,
  importTwilioOutboundForPhone,
  listOutboundSmsForClient,
} from '@/lib/sms-outbound-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE_SIZE = 80;

interface Context {
  params: Promise<{ id: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

export async function GET(
  request: NextRequest,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const { searchParams } = request.nextUrl;
  const beforeRaw = searchParams.get('before');
  const before =
    beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? beforeRaw : null;
  const skipTwilio = searchParams.get('sync') === '0';

  try {
    const { rows } = await sql<{
      id: string;
      phone: string | null;
      first_name: string | null;
      last_name: string | null;
    }>`
      SELECT id::text AS id, phone, first_name, last_name
      FROM clients
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    const client = rows[0];
    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const clientName =
      [client.first_name, client.last_name]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ')
        .trim() || null;

    let twilioSync: {
      imported: number;
      scanned: number;
      skipped: boolean;
      reason?: string;
      error?: string;
    } | null = null;

    if (!before && !skipTwilio && client.phone) {
      try {
        twilioSync = await importTwilioOutboundForPhone({
          toE164: client.phone,
          clientId: client.id,
          clientName,
        });
      } catch (err) {
        console.warn(
          '[api/admin/clients/[id]/sms-messages] Twilio import failed',
          errorMessage(err)
        );
        twilioSync = {
          imported: 0,
          scanned: 0,
          skipped: true,
          reason: 'twilio_error',
          error: errorMessage(err),
        };
      }
    }

    const logRows = await listOutboundSmsForClient({
      clientId: id,
      phone: client.phone,
      limit: PAGE_SIZE,
      before,
    });

    const messages = logRows.map((row) => ({
      id: row.id,
      createdAt: serializeDate(row.created_at),
      templateKey: row.template_key,
      title: displayTitleForTemplateKey(row.template_key),
      body: row.body,
      to: row.to_e164,
      clientId: row.client_id,
      clientName: row.client_name,
      bookingUid: row.booking_uid,
    }));
    const last = messages[messages.length - 1];

    return NextResponse.json({
      phone: client.phone,
      messages,
      nextBefore:
        messages.length === PAGE_SIZE && last ? last.createdAt : null,
      twilioSync,
    });
  } catch (err) {
    console.error(
      '[api/admin/clients/[id]/sms-messages] GET failed',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'load_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
