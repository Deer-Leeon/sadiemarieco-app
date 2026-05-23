import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import ServiceManager, { type Service } from './ServiceManager';

/**
 * Same dynamic posture as the other admin pages: this route reads
 * Clerk cookies and queries Postgres on every render. Static
 * optimisation would fail at build time when env vars aren't present.
 */
export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: number;
  cal_event_id: number;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from node-postgres
  duration_mins: number;
  is_active: boolean;
  slug: string | null;
}

export default async function ServicesPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Same allowlist as the other admin surfaces. Middleware enforces
  // "signed in" for /admin/**; this gate adds "AND on the allowlist".
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  // ── DATA FETCH ─────────────────────────────────────────────────────────
  // We fetch on the server so the editor sees the list painted on first
  // paint (no loading spinner just to get baseline data). The client
  // component takes over from here for all mutations and re-renders.
  let services: Service[] = [];
  let dbError: string | null = null;
  try {
    const { rows } = await sql<ServiceRow>`
      SELECT
        id,
        cal_event_id,
        category,
        title,
        description,
        price,
        duration_mins,
        is_active,
        slug
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY category ASC, title ASC
    `;
    services = rows.map((r) => ({
      ...r,
      price: Number(r.price),
    }));
  } catch (err) {
    console.error('[admin/services] site_services query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      {/*
        Header chrome shared with /admin and /admin/website. The bar
        height + typographic register stay pixel-identical between
        section tabs so only the page body changes when switching.
      */}
      <AdminHeader title="Services" displayName={displayName} />
      <AdminSectionTabs />

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-sm text-stone-500">
            Manage the studio's bookable services. Every change syncs to
            Cal.com first, then mirrors into the site menu — what you
            see here is exactly what customers see on the booking page.
          </p>
        </div>

        {/*
          Editor-facing note about the one config field this CMS can't
          flip from here. Cal's v2 API blocks marking email as optional
          on personal accounts (their issue #25430); the workaround is a
          one-click toggle in Cal's own dashboard, reachable via the
          "Open in Cal" link on each service card. We surface this
          context once at the page level rather than next to every
          card — keeps the cards themselves uncluttered while ensuring
          the editor has the mental model.
        */}
        {services.length > 0 && (
          <div className="rounded-md border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
            <span className="font-medium text-stone-900">Heads up:</span>{' '}
            New services collect{' '}
            <span className="font-medium">First name, Last name, and Phone</span>{' '}
            up front, with email required by default. To make email optional on
            any service, click{' '}
            <span className="font-medium">Open in Cal</span> on its card and
            toggle the email field in Cal's Booking Questions tab — this isn't
            available through the API on the current account tier.
          </div>
        )}

        {dbError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load services: {dbError}. The "Add service" button
            still works — newly created services will appear after the
            page reloads.
          </div>
        )}

        <ServiceManager initialServices={services} />
      </main>
    </div>
  );
}
