import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import ServiceManager, { type Service } from './ServiceManager';
import { reconcileWithCal } from './sync';

/**
 * Same dynamic posture as the other admin pages: this route reads
 * Clerk cookies and queries Postgres on every render. Static
 * optimisation would fail at build time when env vars aren't present.
 */
export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: number;
  cal_event_id: number | null;
  category: string;
  title: string;
  description: string;
  price: string; // NUMERIC arrives as a string from node-postgres
  duration_mins: number | null;
  is_active: boolean;
  slug: string | null;
  is_group: boolean;
  parent_id: number | null;
  color: string | null;
  display_order: number;
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

  // ── RECONCILE WITH CAL ─────────────────────────────────────────────────
  // Soft-delete any local row whose Cal.com event-type was removed
  // directly from the Cal dashboard before we paint the list. `force:
  // true` bypasses the public-facing TTL — the editor expects "I
  // deleted in Cal, refresh shows it" to be immediate. Errors inside
  // the reconciler are warn-logged but never thrown, so a Cal outage
  // can't take down the admin page.
  //
  // This call ALSO closes the loop for the public homepage on the
  // next render — both paths read `site_services` directly, and once
  // an orphan is is_active=FALSE here it stays gone for everyone.
  await reconcileWithCal({ force: true });

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
        slug,
        is_group,
        parent_id,
        color,
        display_order
      FROM site_services
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC
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
            <p>
              <span className="font-medium text-stone-900">Heads up:</span>{' '}
              New and updated services collect{' '}
              <span className="font-medium">
                First name, Last name, Phone, and Email
              </span>{' '}
              on every booking. Email stays required on the Cal.com booking
              form (we do not expose a way to make it optional from here).
            </p>
            <p className="mt-2">
              Every new service gets a{' '}
              <span className="font-medium text-stone-900">
                30-minute minimum lead time
              </span>{' '}
              before any slot is bookable, offers start times every 30 minutes
              (regardless of duration), uses the duration you set for the
              appointment itself (no extra post-appointment buffer), and is
              hidden from the public cal.com/sadiemarie page so this site stays
              the single source of truth for the menu.
            </p>
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
