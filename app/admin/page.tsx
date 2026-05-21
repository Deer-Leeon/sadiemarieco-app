import { auth, currentUser } from '@clerk/nextjs/server';
import { SignOutButton } from '@clerk/nextjs';
import { sql } from '@vercel/postgres';
import { redirect } from 'next/navigation';
import { CalendarClock, LogOut, Users } from 'lucide-react';

// This page reads cookies (Clerk auth) and queries Postgres on every render.
// Force dynamic to keep Next from trying to statically optimise it — without
// this directive `next build` may attempt to prerender, which fails when
// Clerk/POSTGRES env vars aren't available at build time.
export const dynamic = 'force-dynamic';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

// Hardcoded allowlist: both studio owners. We iterate `user.emailAddresses`
// rather than checking only `[0]` because Clerk lets a single account link
// multiple verified emails, and the primary/index ordering is not guaranteed
// stable across sessions (e.g. after the user re-orders or unlinks one).
// Lower-cased for case-insensitive comparison — the local part of an email
// is technically case-sensitive per RFC 5321 but in practice every provider
// treats it as insensitive, and using the strict form here would be a
// foot-gun if either of you ever types your address with capital letters.
const ALLOWED_EMAILS = new Set([
  'lj.buchmiller@gmail.com',
  'mcmarie27@gmail.com',
]);

// Server can run in UTC; format in studio-local time so the admin sees
// times that match what clients see in their booking confirmation emails.
const TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  dateStyle: 'medium',
  timeStyle: 'short',
});

interface AppointmentRow {
  id: number;
  client_first_name: string | null;
  client_last_name: string | null;
  booking_time: string | null;
  service_name: string | null;
  status: string | null;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FORMATTER.format(date);
}

function StatusBadge({ status }: { status: string | null }) {
  const normalised = (status || '').toLowerCase();
  if (normalised === 'confirmed') {
    return <Badge variant="success">Confirmed</Badge>;
  }
  if (normalised === 'cancelled') {
    return <Badge variant="warning">Cancelled</Badge>;
  }
  return <Badge variant="secondary">{status || 'Unknown'}</Badge>;
}

export default async function AdminPage() {
  // ── AUTH GATE ────────────────────────────────────────────────────────────
  // Middleware has already enforced "signed in" before this server component
  // runs. We re-derive `userId` here only to satisfy the type narrowing for
  // currentUser() and to fail-closed if Clerk's middleware is ever
  // mis-configured (defence in depth).
  const { userId } = await auth();
  if (!userId) {
    redirect('/');
  }

  const user = await currentUser();

  // ── EMAIL ALLOWLIST GATE ────────────────────────────────────────────────
  // Iterate ALL linked emails on the Clerk user (not just `[0]`). A user can
  // have multiple verified emails — checking only the first would be brittle
  // if the user re-orders or unlinks the matching address.
  const userEmails =
    user?.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];
  const hasAccess = userEmails.some((e) => ALLOWED_EMAILS.has(e));

  if (!hasAccess) {
    // Bounce immediately. Not a 403 page — the user shouldn't even know
    // /admin exists.
    redirect('/');
  }

  // ── DATA FETCH ──────────────────────────────────────────────────────────
  // Newest 50 by booking_time. NULLS LAST so rows with missing booking_time
  // (created via an incomplete webhook) sink to the bottom rather than
  // dominating the top of the list (Postgres default ORDER BY DESC puts
  // NULLs first).
  //
  // Wrapped in try/catch so a DB outage shows a graceful empty state instead
  // of an unhandled 500. The catch path renders the dashboard chrome with a
  // banner — better UX than the Next.js error boundary.
  let appointments: AppointmentRow[] = [];
  let dbError: string | null = null;
  try {
    const { rows } = await sql<AppointmentRow>`
      SELECT id, client_first_name, client_last_name, booking_time,
             service_name, status
      FROM appointments
      ORDER BY booking_time DESC NULLS LAST
      LIMIT 50
    `;
    appointments = rows;
  } catch (err) {
    console.error('[admin] appointments query failed:', err);
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  const confirmedCount = appointments.filter(
    (a) => (a.status || '').toLowerCase() === 'confirmed'
  ).length;
  const cancelledCount = appointments.filter(
    (a) => (a.status || '').toLowerCase() === 'cancelled'
  ).length;

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Sadie Marie · Admin
            </p>
            <h1 className="mt-2 font-serif text-3xl text-foreground sm:text-4xl">
              Bookings Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Latest 50 appointments — newest first.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.firstName || userEmails[0]}
            </span>
            <SignOutButton redirectUrl="/">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </SignOutButton>
          </div>
        </header>

        {/* ── SUMMARY STAT CARDS ─────────────────────────────────────── */}
        <section className="mb-8 grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <CardTitle className="text-base font-medium">Total</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="font-serif text-3xl">{appointments.length}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Shown on this page
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <CardTitle className="text-base font-medium">Confirmed</CardTitle>
              <CalendarClock className="h-4 w-4 text-emerald-400" />
            </CardHeader>
            <CardContent>
              <div className="font-serif text-3xl text-emerald-300">
                {confirmedCount}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Active appointments
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <CardTitle className="text-base font-medium">Cancelled</CardTitle>
              <CalendarClock className="h-4 w-4 text-amber-400" />
            </CardHeader>
            <CardContent>
              <div className="font-serif text-3xl text-amber-300">
                {cancelledCount}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                In current window
              </p>
            </CardContent>
          </Card>
        </section>

        {/* ── BOOKINGS TABLE ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Recent bookings</CardTitle>
            <CardDescription>
              Synced from Cal.com via the booking webhook. Cancellations are
              reflected here in near-real-time.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            {dbError ? (
              <div className="mx-6 mb-6 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-foreground">
                Could not load bookings: {dbError}
              </div>
            ) : appointments.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                No bookings yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Booking time</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {appointments.map((row) => {
                    const fullName =
                      [row.client_first_name, row.client_last_name]
                        .filter(Boolean)
                        .join(' ') || '—';
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium text-foreground">
                          {fullName}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.service_name || '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatTime(row.booking_time)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end">
                            <StatusBadge status={row.status} />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <footer className="mt-10 text-center text-xs text-muted-foreground">
          {appointments.length} booking{appointments.length === 1 ? '' : 's'} ·
          all times shown in Mountain Time
        </footer>
      </div>
    </div>
  );
}
