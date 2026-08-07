/**
 * Postgres booking-funnel rollups for /admin/funnel.
 *
 * Ground truth for hold → confirm vs abandon (canceled_by_system).
 * Early steps (service open, Cal steps) live in Vercel Analytics only.
 */

import { sql } from '@vercel/postgres';

import { formatServiceTitleForDisplay } from '@/lib/format-booking-time';
import { STUDIO_TIMEZONE } from '@/lib/cal-config';

export type FunnelRangeDays = 1 | 7 | 30 | 90;

export interface FunnelServiceRow {
  service: string;
  total: number;
  confirmed: number;
  pendingCheckout: number;
  abandonedCheckout: number;
  canceledOther: number;
  /** confirmed / (confirmed + abandoned + pending) — excludes unrelated cancels */
  checkoutConversionPct: number | null;
}

export interface FunnelHoldRow {
  id: string;
  service: string;
  status: string;
  statusLabel: string;
  clientName: string;
  clientId: string | null;
  holdCreatedAt: string;
  bookingTime: string | null;
}

export interface FunnelSummary {
  rangeDays: FunnelRangeDays;
  since: string;
  totals: {
    total: number;
    confirmed: number;
    pendingCheckout: number;
    abandonedCheckout: number;
    canceledOther: number;
    checkoutConversionPct: number | null;
  };
  byService: FunnelServiceRow[];
  recentHolds: FunnelHoldRow[];
}

function conversionPct(
  confirmed: number,
  pending: number,
  abandoned: number
): number | null {
  const denom = confirmed + pending + abandoned;
  if (denom <= 0) return null;
  return Math.round((confirmed / denom) * 1000) / 10;
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function serializeTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function funnelStatusLabel(status: string | null | undefined): string {
  switch ((status || '').toLowerCase()) {
    case 'pending':
      return 'Pending checkout';
    case 'confirmed':
      return 'Confirmed';
    case 'canceled_by_system':
      return 'Abandoned checkout';
    case 'canceled_by_client':
      return 'Canceled by client';
    case 'canceled_by_client_late':
      return 'Late cancel';
    case 'canceled_by_admin':
      return 'Canceled by admin';
    case 'canceled':
    case 'cancelled':
      return 'Canceled';
    case 'no-show':
      return 'No-show';
    default:
      return status?.trim() || 'Unknown';
  }
}

/** Studio-local label for hold / appointment instants on the funnel page. */
export function formatFunnelTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export async function getBookingFunnelStats(
  rangeDays: FunnelRangeDays = 30
): Promise<FunnelSummary> {
  const since = new Date();
  since.setTime(since.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const [aggResult, holdsResult] = await Promise.all([
    sql<{
      service: string;
      total: string | number;
      confirmed: string | number;
      pending_checkout: string | number;
      abandoned_checkout: string | number;
      canceled_other: string | number;
    }>`
      SELECT
        COALESCE(
          NULLIF(
            TRIM(SPLIT_PART(COALESCE(service_name, ''), ' between ', 1)),
            ''
          ),
          'Unknown'
        ) AS service,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, '')) = 'confirmed'
        )::int AS confirmed,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, '')) = 'pending'
        )::int AS pending_checkout,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, '')) = 'canceled_by_system'
        )::int AS abandoned_checkout,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, '')) NOT IN (
            'confirmed',
            'pending',
            'canceled_by_system'
          )
          AND COALESCE(TRIM(status), '') <> ''
        )::int AS canceled_other
      FROM appointments
      WHERE created_at >= ${sinceIso}::timestamptz
        AND cal_event_id IS NOT NULL
      GROUP BY 1
      ORDER BY total DESC, service ASC
    `,
    sql<{
      id: string;
      service_name: string | null;
      status: string | null;
      client_id: string | null;
      client_first_name: string | null;
      client_last_name: string | null;
      created_at: Date | string | null;
      booking_time: Date | string | null;
    }>`
      SELECT
        id::text AS id,
        service_name,
        status,
        client_id::text AS client_id,
        client_first_name,
        client_last_name,
        created_at,
        booking_time
      FROM appointments
      WHERE created_at >= ${sinceIso}::timestamptz
        AND cal_event_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 100
    `,
  ]);

  const byService: FunnelServiceRow[] = aggResult.rows.map((row) => {
    const confirmed = toInt(row.confirmed);
    const pendingCheckout = toInt(row.pending_checkout);
    const abandonedCheckout = toInt(row.abandoned_checkout);
    return {
      service: row.service || 'Unknown',
      total: toInt(row.total),
      confirmed,
      pendingCheckout,
      abandonedCheckout,
      canceledOther: toInt(row.canceled_other),
      checkoutConversionPct: conversionPct(
        confirmed,
        pendingCheckout,
        abandonedCheckout
      ),
    };
  });

  const totals = byService.reduce(
    (acc, row) => {
      acc.total += row.total;
      acc.confirmed += row.confirmed;
      acc.pendingCheckout += row.pendingCheckout;
      acc.abandonedCheckout += row.abandonedCheckout;
      acc.canceledOther += row.canceledOther;
      return acc;
    },
    {
      total: 0,
      confirmed: 0,
      pendingCheckout: 0,
      abandonedCheckout: 0,
      canceledOther: 0,
    }
  );

  const recentHolds: FunnelHoldRow[] = holdsResult.rows.map((row) => {
    const first = (row.client_first_name || '').trim();
    const last = (row.client_last_name || '').trim();
    const clientName = [first, last].filter(Boolean).join(' ') || '—';
    const holdCreatedAt = serializeTimestamp(row.created_at) || '';
    return {
      id: row.id,
      service: formatServiceTitleForDisplay(row.service_name) || 'Unknown',
      status: (row.status || '').toLowerCase(),
      statusLabel: funnelStatusLabel(row.status),
      clientName,
      clientId: row.client_id,
      holdCreatedAt,
      bookingTime: serializeTimestamp(row.booking_time),
    };
  });

  return {
    rangeDays,
    since: sinceIso,
    totals: {
      ...totals,
      checkoutConversionPct: conversionPct(
        totals.confirmed,
        totals.pendingCheckout,
        totals.abandonedCheckout
      ),
    },
    byService,
    recentHolds,
  };
}
