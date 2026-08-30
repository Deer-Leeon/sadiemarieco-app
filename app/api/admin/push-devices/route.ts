/**
 * POST   /api/admin/push-devices  — upsert this device's APNs token
 * DELETE /api/admin/push-devices  — remove token on logout
 *
 * Always-on booking alerts: the iOS app registers while a Clerk session
 * is active and unregisters only on explicit Log Out.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { isAllowedAdminEmail } from '@/lib/admin-allowlist';
import { ensureAdminPushDevicesTable } from '@/lib/admin-booking-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TOKEN_RE = /^[A-Fa-f0-9]{64,200}$/;
const ALLOWED_BUNDLE_IDS = new Set([
  'com.lj-buchmiller.SadieMarie',
  'com.lj-buchmiller.SadieMarie.dev',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return TOKEN_RE.test(token) ? token.toLowerCase() : null;
}

function parseBundleId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return ALLOWED_BUNDLE_IDS.has(id) ? id : null;
}

function parseEnvironment(raw: unknown): 'development' | 'production' | null {
  if (raw === 'development' || raw === 'production') return raw;
  return null;
}

function primaryEmail(emails: string[]): string | null {
  const allowed = emails.find((e) => isAllowedAdminEmail(e));
  return allowed ?? emails[0] ?? null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const deviceToken = parseToken(body.device_token ?? body.deviceToken);
  const bundleId = parseBundleId(body.bundle_id ?? body.bundleId);
  const environment = parseEnvironment(body.environment);
  const email = primaryEmail(access.emails);

  if (!deviceToken) {
    return NextResponse.json(
      { error: 'invalid_device_token', message: 'APNs device token must be 64–200 hex characters.' },
      { status: 400 }
    );
  }
  if (!bundleId) {
    return NextResponse.json(
      { error: 'invalid_bundle_id', message: 'Unknown iOS bundle id.' },
      { status: 400 }
    );
  }
  if (!environment) {
    return NextResponse.json(
      { error: 'invalid_environment', message: 'environment must be development or production.' },
      { status: 400 }
    );
  }
  if (!email) {
    return NextResponse.json({ error: 'missing_email' }, { status: 400 });
  }

  try {
    await ensureAdminPushDevicesTable();
    await sql`
      INSERT INTO admin_push_devices (
        clerk_user_id, email, device_token, bundle_id, environment, updated_at
      )
      VALUES (
        ${access.userId}, ${email}, ${deviceToken}, ${bundleId}, ${environment}, NOW()
      )
      ON CONFLICT (device_token) DO UPDATE SET
        clerk_user_id = EXCLUDED.clerk_user_id,
        email = EXCLUDED.email,
        bundle_id = EXCLUDED.bundle_id,
        environment = EXCLUDED.environment,
        updated_at = NOW()
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/admin/push-devices] POST failed', errorMessage(err));
    return NextResponse.json(
      { error: 'register_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const deviceToken = parseToken(body.device_token ?? body.deviceToken);
  if (!deviceToken) {
    return NextResponse.json(
      { error: 'invalid_device_token' },
      { status: 400 }
    );
  }

  try {
    await ensureAdminPushDevicesTable();
    await sql`
      DELETE FROM admin_push_devices
      WHERE device_token = ${deviceToken}
        AND clerk_user_id = ${access.userId}
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/admin/push-devices] DELETE failed', errorMessage(err));
    return NextResponse.json(
      { error: 'unregister_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
