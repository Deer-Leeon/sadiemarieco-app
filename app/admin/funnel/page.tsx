import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';

import {
  formatFunnelTimestamp,
  getBookingFunnelStats,
  type FunnelRangeDays,
  type FunnelSummary,
} from '@/lib/booking-funnel-stats';

import { getAdminAccess } from '../auth';
import AdminHeader from '../AdminHeader';
import AdminSectionTabs from '../AdminSectionTabs';

export const dynamic = 'force-dynamic';

const RANGES: FunnelRangeDays[] = [1, 7, 30, 90];

function parseRange(raw: string | undefined): FunnelRangeDays {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 30;
}

function pctLabel(value: number | null): string {
  if (value == null) return '—';
  return `${value}%`;
}

function statusTone(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'text-emerald-800';
    case 'pending':
      return 'text-amber-800';
    case 'canceled_by_system':
      return 'text-rose-800';
    default:
      return 'text-stone-600';
  }
}

function FunnelTotals({ summary }: { summary: FunnelSummary }) {
  const { totals } = summary;
  const cards = [
    { label: 'Holds started', value: totals.total },
    { label: 'Confirmed', value: totals.confirmed },
    { label: 'Abandoned checkout', value: totals.abandonedCheckout },
    { label: 'Still pending', value: totals.pendingCheckout },
    { label: 'Other outcome', value: totals.canceledOther },
    {
      label: 'Checkout → booked',
      value: pctLabel(totals.checkoutConversionPct),
    },
  ];

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="border-b border-stone-200 pb-3 sm:border-b-0 sm:pb-0"
        >
          <dt className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            {card.label}
          </dt>
          <dd className="mt-1 font-serif text-2xl text-stone-900 tabular-nums">
            {card.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AdminFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const access = await getAdminAccess();
  if (!access.userId) redirect('/');
  if (!access.hasAccess) redirect('/');

  const sp = await searchParams;
  const rangeDays = parseRange(sp.days);
  const summary = await getBookingFunnelStats(rangeDays);

  const user = await currentUser();
  const displayName = user?.firstName || access.emails[0] || 'Admin';

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      <AdminHeader title="Booking Funnel" displayName={displayName} />
      <AdminSectionTabs />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
              Public checkout funnel
            </p>
            <p className="mt-2 max-w-xl text-sm text-stone-500">
              Holds created after someone submits details in Cal, then
              confirms or abandons card checkout. Earlier steps (service
              opened, Cal calendar / details) are in Vercel Analytics →
              Events.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {RANGES.map((days) => {
              const active = days === rangeDays;
              return (
                <Link
                  key={days}
                  href={`/admin/funnel?days=${days}`}
                  aria-current={active ? 'page' : undefined}
                  className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.2em] transition-colors ${
                    active
                      ? 'text-stone-900'
                      : 'text-stone-400 hover:text-stone-700'
                  }`}
                >
                  {days}d
                </Link>
              );
            })}
          </div>
        </div>

        <section className="mt-8 border-t border-stone-200 pt-6">
          <FunnelTotals summary={summary} />
        </section>

        <section className="mt-10">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
            By service
          </h2>
          {summary.byService.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">
              No public booking holds in this window yet.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-xl text-left text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400">
                    <th className="py-2 pr-4 font-medium">Service</th>
                    <th className="py-2 pr-4 font-medium tabular-nums">Holds</th>
                    <th className="py-2 pr-4 font-medium tabular-nums">
                      Confirmed
                    </th>
                    <th className="py-2 pr-4 font-medium tabular-nums">
                      Abandoned
                    </th>
                    <th className="py-2 pr-4 font-medium tabular-nums">
                      Pending
                    </th>
                    <th className="py-2 pr-4 font-medium tabular-nums">Other</th>
                    <th className="py-2 font-medium tabular-nums">Convert</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byService.map((row) => (
                    <tr
                      key={row.service}
                      className="border-b border-stone-100 text-stone-800"
                    >
                      <td className="py-2.5 pr-4">{row.service}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{row.total}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {row.confirmed}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {row.abandonedCheckout}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {row.pendingCheckout}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {row.canceledOther}
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {pctLabel(row.checkoutConversionPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
              Recent holds
            </h2>
            <p className="text-xs text-stone-400">
              Hold created = when they submitted Cal details. Newest first
              (up to 100).
            </p>
          </div>
          {summary.recentHolds.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">
              No holds in this window yet.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-xl text-left text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400">
                    <th className="py-2 pr-4 font-medium">Hold created</th>
                    <th className="py-2 pr-4 font-medium">Service</th>
                    <th className="py-2 pr-4 font-medium">Client</th>
                    <th className="py-2 pr-4 font-medium">Appointment</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recentHolds.map((hold) => (
                    <tr
                      key={hold.id}
                      className="border-b border-stone-100 text-stone-800"
                    >
                      <td className="py-2.5 pr-4 whitespace-nowrap tabular-nums text-stone-600">
                        {formatFunnelTimestamp(hold.holdCreatedAt)}
                      </td>
                      <td className="py-2.5 pr-4">{hold.service}</td>
                      <td className="py-2.5 pr-4">{hold.clientName}</td>
                      <td className="py-2.5 pr-4 whitespace-nowrap tabular-nums text-stone-600">
                        {formatFunnelTimestamp(hold.bookingTime)}
                      </td>
                      <td
                        className={`py-2.5 ${statusTone(hold.status)}`}
                      >
                        {hold.statusLabel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
