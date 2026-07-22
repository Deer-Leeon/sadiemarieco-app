/**
 * GET /api/admin/manual-booking/services
 *
 * Bookable service catalogue for the manual-booking wizard (admin
 * dashboard "New booking" and client-profile "Book appointment").
 * Same shape as `loadCalEventTypeMaps()` used by `/admin` SSR.
 *
 * Auth: `requireAdminUser()`.
 */
import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { loadCalEventTypeMaps } from '@/lib/cal-config';

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
    const { services, groupHeaders } = await loadCalEventTypeMaps();
    return NextResponse.json({ services, groupHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/admin/manual-booking/services] GET failed:', message);
    return NextResponse.json(
      { error: 'services_load_failed', message },
      { status: 500 }
    );
  }
}
