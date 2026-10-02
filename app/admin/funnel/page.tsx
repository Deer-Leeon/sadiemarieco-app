import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';

import {
  formatAttemptMinutes,
  getBookingAttemptFunnel,
  type AttemptFunnel,
  type AttemptStageStat,
  type CheckoutMethodCounts,
} from '@/lib/booking-attempt-stats';
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

function methodBits(counts: CheckoutMethodCounts): string | null {
  const total = counts.applePay + counts.card + counts.googlePay + counts.link;
  if (total === 0) return null;
  const parts = [`Apple Pay ${counts.applePay}`, `Card ${counts.card}`];
  if (counts.googlePay > 0) parts.push(`Google Pay ${counts.googlePay}`);
  if (counts.link > 0) parts.push(`Link ${counts.link}`);
  return parts.join(' · ');
}

function checkoutLine(
  booked: CheckoutMethodCounts,
  leftPay: CheckoutMethodCounts
): string | null {
  const bookedBits = methodBits(booked);
  const leftBits = methodBits(leftPay);
  if (!bookedBits && !leftBits) return null;
  const sentences: string[] = [];
  if (bookedBits) sentences.push(`Booked with ${bookedBits}`);
  if (leftBits) sentences.push(`Left during payment with ${leftBits}`);
  return `${sentences.join('. ')}.`;
}

function leftShare(stage: AttemptStageStat): string {
  if (stage.reached === 0) return '—';
  if (stage.left === 0) return '0';
  const pct = stage.leftPercent;
  if (pct == null) return String(stage.left);
  const shown = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${stage.left} · ${shown}%`;
}

function AttemptSteps({ attempts }: { attempts: AttemptFunnel }) {
  const cards = [
    { label: 'Started', value: String(attempts.started) },
    { label: 'Still going', value: String(attempts.active) },
    { label: 'Left', value: String(attempts.abandoned) },
    { label: 'Booked', value: String(attempts.confirmed) },
    {
      label: 'Time to book',
      value: formatAttemptMinutes(attempts.medianBookedMinutes),
    },
    {
      label: 'Time before leaving',
      value: formatAttemptMinutes(attempts.medianLeftMinutes),
    },
  ];
  const checkout = checkoutLine(
    attempts.bookedByMethod,
    attempts.leftAtPaymentByMethod
  );

  return (
    <section className="mt-8 border-t border-stone-200 pt-6">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
        From the first step
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-stone-500">
        Phone and computer are counted apart. Reaching a later step counts
        as having passed the ones before it. Left is the last step they
        were on.
      </p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
      {checkout ? (
        <p className="mt-4 max-w-2xl text-sm text-stone-600">{checkout}</p>
      ) : null}
      {attempts.started === 0 ? (
        <p className="mt-4 text-sm text-stone-500">
          These counts start with the next booking attempt. Holds already
          in progress are still listed below.
        </p>
      ) : null}
      <div className="mt-8 grid gap-10 lg:grid-cols-2">
        {attempts.surfaces.map((surface) => (
          <div key={surface.surface}>
            <h3 className="font-serif text-xl text-stone-900">
              {surface.label}
            </h3>
            <p className="mt-1 text-xs text-stone-500">
              {surface.started} started · {surface.active} still going ·{' '}
              {surface.abandoned} left · {surface.confirmed} booked
            </p>
            <p className="mt-1 text-xs text-stone-400">
              Median {formatAttemptMinutes(surface.medianBookedMinutes)} to
              book · {formatAttemptMinutes(surface.medianLeftMinutes)} before
              leaving
            </p>
            {checkoutLine(surface.bookedByMethod, surface.leftAtPaymentByMethod) ? (
              <p className="mt-1 text-xs text-stone-600">
                {checkoutLine(
                  surface.bookedByMethod,
                  surface.leftAtPaymentByMethod
                )}
              </p>
            ) : null}
            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400">
                  <th className="py-2 pr-3 font-medium">Step</th>
                  <th className="py-2 pr-3 font-medium tabular-nums">
                    Reached
                  </th>
                  <th className="py-2 pr-3 font-medium tabular-nums">
                    Left here
                  </th>
                  <th className="py-2 font-medium tabular-nums">Median</th>
                </tr>
              </thead>
              <tbody>
                {surface.stages.map((stage) => (
                  <tr
                    key={stage.id}
                    className="border-b border-stone-100 text-stone-800"
                  >
                    <td className="py-2.5 pr-3">{stage.label}</td>
                    <td className="py-2.5 pr-3 tabular-nums">{stage.reached}</td>
                    <td className="py-2.5 pr-3 tabular-nums text-stone-600">
                      {leftShare(stage)}
                    </td>
                    <td className="py-2.5 tabular-nums text-stone-600">
                      {formatAttemptMinutes(stage.medianMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
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
  const [summary, attempts] = await Promise.all([
    getBookingFunnelStats(rangeDays),
    getBookingAttemptFunnel(rangeDays),
  ]);

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
              A start is opening the phone booker, or opening a service on a
              computer. Still going means they moved in the last 30 minutes.
              After that, or if they close the tab, they count as left at
              their last step. Booked is a successful payment. The holds
              below begin once their details are in.
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

        <AttemptSteps attempts={attempts} />

        <section className="mt-10 border-t border-stone-200 pt-6">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-400">
            After details are submitted
          </h2>
          <div className="mt-5">
            <FunnelTotals summary={summary} />
          </div>
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
