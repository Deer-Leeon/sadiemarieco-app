/**
 * GET/PATCH /api/admin/settings/staging-sms
 *
 * Staging-only toggle for real Twilio outbound SMS. Production always
 * allows SMS and rejects this route with 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { isStagingDeployment } from '@/lib/staging';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

let columnEnsured = false;

/** Idempotent — staging may lag production until Sunday Neon reset. */
async function ensureStagingSmsColumn(): Promise<void> {
  if (columnEnsured) return;
  await sql.query(`
    ALTER TABLE studio_settings
      ADD COLUMN IF NOT EXISTS staging_outbound_sms_enabled BOOLEAN NOT NULL DEFAULT false
  `);
  columnEnsured = true;
}

function notStagingResponse(): NextResponse {
  return NextResponse.json(
    { error: 'not_staging', message: 'This setting is only available on staging.' },
    { status: 404 }
  );
}

export async function GET(): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  if (!isStagingDeployment()) return notStagingResponse();

  try {
    await ensureStagingSmsColumn();
    const { rows } = await sql`
      SELECT staging_outbound_sms_enabled
      FROM studio_settings
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
      LIMIT 1
    `;

    if (!rows[0]) {
      return NextResponse.json(
        {
          error: 'settings_row_missing',
          hint: 'Run scripts/create_studio_settings.sql',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      enabled: rows[0].staging_outbound_sms_enabled === true,
    });
  } catch (err) {
    console.error('[api/admin/settings/staging-sms] GET failed', err);
    return NextResponse.json(
      {
        error: 'db_select_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  if (!isStagingDeployment()) return notStagingResponse();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const enabled =
    body &&
    typeof body === 'object' &&
    'enabled' in body &&
    typeof (body as { enabled: unknown }).enabled === 'boolean'
      ? (body as { enabled: boolean }).enabled
      : null;

  if (enabled === null) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Expected { enabled: boolean }' },
      { status: 400 }
    );
  }

  try {
    await ensureStagingSmsColumn();
    const { rows } = await sql`
      UPDATE studio_settings
      SET
        staging_outbound_sms_enabled = ${enabled},
        updated_at = NOW()
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
      RETURNING staging_outbound_sms_enabled
    `;

    if (!rows[0]) {
      return NextResponse.json(
        { error: 'settings_row_missing' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      enabled: rows[0].staging_outbound_sms_enabled === true,
    });
  } catch (err) {
    console.error('[api/admin/settings/staging-sms] PATCH failed', err);
    return NextResponse.json(
      {
        error: 'db_update_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
