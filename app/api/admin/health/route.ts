/**
 * GET /api/admin/health
 *
 * Runs integration probes for every dependency in the booking lifecycle.
 * Admin-only (email allowlist via requireAdminUser).
 */

import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { runHealthChecks } from '@/lib/health-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  try {
    const report = await runHealthChecks();
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/admin/health] run failed', { message });
    return NextResponse.json(
      { error: 'health_check_failed', message },
      { status: 500 }
    );
  }
}
