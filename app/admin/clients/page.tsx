/**
 * /admin/clients — top-level CRM directory.
 *
 * Server component that loads the entire `clients` table on every
 * request (force-dynamic, no cache) and hands it to the interactive
 * `<ClientDirectory />` for the search + list UI.
 *
 * Why load everything up-front rather than searching server-side:
 *   The studio's client base is small enough (low four-figures at
 *   absolute most) that a single SELECT is cheaper than the
 *   debounced request-per-keystroke pattern, and it lets the search
 *   feel truly real-time (no flicker, no network spinner). Once the
 *   table grows past ~10k rows we'd switch to server-side ILIKE
 *   queries with pagination — this file is the right place to make
 *   that switch when the time comes.
 */
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';
import type { Client } from '../types';
import ClientDirectory from './ClientDirectory';

// Same dynamic posture as the other admin pages: this route reads
// Clerk cookies and queries Postgres on every render. Static
// optimisation would fail at build time when env vars aren't present.
export const dynamic = 'force-dynamic';

interface ClientRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  // @vercel/postgres returns TIMESTAMPTZ as either a Date or an ISO
  // string depending on environment. We normalise to an ISO string
  // before crossing the server → client boundary so the wire format
  // matches the `Client.created_at: string | null` contract.
  created_at: Date | string | null;
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default async function ClientsPage() {
  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Same allowlist as the other admin surfaces. Middleware enforces
  // "signed in" for /admin/**; this gate adds "AND on the allowlist".
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  // ── DATA FETCH ─────────────────────────────────────────────────────────
  // ORDER BY first_name ASC per spec. NULLS LAST so legacy rows
  // missing a first name fall to the bottom rather than sorting
  // before "Aaron" (Postgres default puts NULLs first on ASC). The
  // client side re-sorts only the filtered view, so this is the
  // canonical order whenever the search box is empty.
  let clients: Client[] = [];
  let dbError: string | null = null;
  try {
    const { rows } = await sql<ClientRow>`
      SELECT id, phone, first_name, last_name, email, created_at
      FROM clients
      ORDER BY first_name ASC NULLS LAST, last_name ASC NULLS LAST
    `;
    clients = rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      created_at: serializeDate(r.created_at),
    }));
  } catch (err) {
    console.error('[admin/clients] clients query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      {/*
        Shared header + tabs so the bar height + typographic register
        stay pixel-identical between admin sections — only the body
        below should change when switching tabs.
      */}
      <AdminHeader title="Clients" displayName={displayName} />
      <AdminSectionTabs />

      <main className="mx-auto max-w-3xl px-6 py-8">
        {dbError && (
          <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Could not load clients: {dbError}. Try refreshing — if it
            keeps failing, check the Postgres connection.
          </div>
        )}

        <ClientDirectory clients={clients} />
      </main>
    </div>
  );
}
