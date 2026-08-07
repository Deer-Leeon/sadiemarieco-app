/**
 * Postgres booking-funnel rollups for /admin/funnel.
 *
 * Ground truth for hold → confirm vs abandon (canceled_by_system).
 * Early steps (service open, Cal steps) live in Vercel Analytics only.
 */

import { sql } from '@vercel/postgres';

export type FunnelRangeDays = 7 | 30 | 90;

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

export async function getBookingFunnelStats(
  rangeDays: FunnelRangeDays = 30
): Promise<FunnelSummary> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - rangeDays);
  const sinceIso = since.toISOString();

  const { rows } = await sql<{
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
        WHERE LOWER(COALESCE(status, '')) IN (
          'canceled_by_client',
          'canceled_by_client_late',
          'canceled',
          'cancelled',
          'no-show'
        )
      )::int AS canceled_other
    FROM appointments
    WHERE created_at >= ${sinceIso}::timestamptz
      AND cal_event_id IS NOT NULL
    GROUP BY 1
    ORDER BY total DESC, service ASC
  `;

  const byService: FunnelServiceRow[] = rows.map((row) => {
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
  };
}
