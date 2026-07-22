/**
 * /admin/availability
 *
 * Server-rendered shell for the studio's Cal.com schedule editor.
 *
 * Loads the default schedule from Cal at request time (via the
 * shared helper in ./calSchedules, NOT through the /api/admin/
 * availability proxy — the proxy exists for the browser to use
 * post-paint, but the server already has CAL_API_KEY in scope and
 * paying for an extra hop here would just slow the first paint).
 * Hands the schedule to AvailabilityClient, which owns every
 * mutation from that point forward and POSTs them back through the
 * proxy route.
 *
 * The page surface stays minimal — heading + timezone note + the
 * client component. All editor state and toast feedback live in
 * AvailabilityClient so the Server Component does not need to be
 * client-aware.
 */
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import { getAdminAccess } from '../auth';

import AvailabilityClient from './AvailabilityClient';
import {
  fetchDefaultSchedule,
  STUDIO_TIMEZONE,
  type Schedule,
} from './calSchedules';

/**
 * Force dynamic rendering — same posture as the other admin pages.
 * Static optimisation would fail at build time because the page
 * reads Clerk cookies AND fires an authenticated Cal.com fetch,
 * neither of which is available in a static build context.
 */
export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Middleware enforces "signed in" for /admin/**; this gate adds
  // "AND on the email allowlist". Same pattern as /admin/services.
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  // ── DATA FETCH ─────────────────────────────────────────────────────────
  // We swallow Cal failures into `loadError` rather than throwing so
  // the page chrome (header, tabs) still renders and the editor sees
  // a clear "couldn't load" banner instead of a Next.js error page.
  let initial: Schedule | null = null;
  let loadError: string | null = null;
  try {
    const apiKey = process.env.CAL_API_KEY;
    if (!apiKey) {
      throw new Error('CAL_API_KEY is not configured on the server.');
    }
    initial = await fetchDefaultSchedule(apiKey);
  } catch (err) {
    console.error('[admin/availability] schedule fetch failed:', err);
    loadError = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="Availability" displayName={displayName} />
      <AdminSectionTabs />

      <main className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-sm text-stone-500">
            Set the studio's weekly recurring hours and add one-off date
            overrides. Past override dates archive automatically and are
            removed from Cal.com so only upcoming carve-outs stay active.
          </p>
          <p className="shrink-0 text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
            Timezone · {STUDIO_TIMEZONE.replace('_', ' ')}
          </p>
        </div>

        {loadError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load the schedule from Cal.com: {loadError}
          </div>
        )}

        {initial && <AvailabilityClient initial={initial} />}
      </main>
    </div>
  );
}
