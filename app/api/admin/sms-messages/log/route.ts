/**
 * GET /api/admin/sms-messages/log
 *
 * Local ledger of outbound studio SMS (exact body as sent). Newest first.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  displayTitleForTemplateKey,
  listOutboundSms,
} from '@/lib/sms-outbound-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 40;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { searchParams } = request.nextUrl;
  const beforeRaw = searchParams.get('before');
  const before =
    beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? beforeRaw : null;

  try {
    const rows = await listOutboundSms({ limit: PAGE_SIZE, before });
    const messages = rows.map((row) => {
      const createdAt =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
      return {
        id: row.id,
        createdAt,
        templateKey: row.template_key,
        title: displayTitleForTemplateKey(row.template_key),
        body: row.body,
        to: row.to_e164,
        clientId: row.client_id,
        clientName: row.client_name,
        bookingUid: row.booking_uid,
      };
    });
    const last = messages[messages.length - 1];
    return NextResponse.json({
      messages,
      nextBefore:
        messages.length === PAGE_SIZE && last ? last.createdAt : null,
    });
  } catch (err) {
    console.error('[api/admin/sms-messages/log] GET failed', err);
    return NextResponse.json(
      {
        error: 'load_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
