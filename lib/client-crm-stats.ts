/**
 * CRM aggregate stats for a client — single source of truth shared by
 * the directory (`app/admin/clients/page.tsx`) and the profile modal
 * (`/api/admin/clients/[id]/appointments`).
 *
 * Mirrors the LEFT JOIN LATERAL logic on `appointments` + `site_services`.
 */
import { sql } from '@vercel/postgres';

import type { ClientCrmStats } from '@/app/admin/types';
import { EMPTY_CLIENT_CRM_STATS } from '@/app/admin/types';

/** Statuses excluded from total_bookings (matches directory SQL). */
export const CRM_NON_BOOKING_STATUSES = new Set([
  'pending',
  'canceled_by_admin',
  'canceled_by_client',
  'canceled_by_client_late',
  'canceled_by_system',
  'cancelled',
]);

export function normalizeAppointmentStatus(status: string | null): string {
  return (status || '').toLowerCase().trim();
}

export function countsAsBooking(status: string | null): boolean {
  return !CRM_NON_BOOKING_STATUSES.has(normalizeAppointmentStatus(status));
}

export function countsForLifetimeValue(
  status: string | null,
  bookingTime: string | null,
  nowMs: number = Date.now()
): boolean {
  const s = normalizeAppointmentStatus(status);
  if (s !== 'confirmed' && s !== 'no-show') return false;
  if (!bookingTime) return false;
  const startMs = Date.parse(bookingTime);
  return Number.isFinite(startMs) && startMs < nowMs;
}

export function hasVaultedStripeCustomer(stripeCustomerId: string | null): boolean {
  return (
    typeof stripeCustomerId === 'string' && stripeCustomerId.trim().length > 0
  );
}

export function countsForRisk(status: string | null): boolean {
  const s = normalizeAppointmentStatus(status);
  return s === 'no-show' || s === 'canceled_by_client_late';
}

/**
 * Client-side fallback when SQL stats are unavailable. Pass
 * `includePendingAndCanceledForVault: true` only when the input array
 * contains pending/canceled rows (the history API does not).
 */
export function computeCrmStatsFromAppointments(
  appointments: Array<{
    status: string | null;
    booking_time: string | null;
    service_price: number | null;
    stripe_customer_id: string | null;
    created_at?: string | null;
  }>,
  options?: { includePendingAndCanceledForVault?: boolean }
): ClientCrmStats {
  const now = Date.now();
  let total_bookings = 0;
  let lifetime_value = 0;
  let has_vaulted_card = false;
  let risk_flag = false;
  let lastBookedMs = Number.NEGATIVE_INFINITY;

  for (const a of appointments) {
    if (a.created_at) {
      const ms = Date.parse(a.created_at);
      if (Number.isFinite(ms) && ms > lastBookedMs) lastBookedMs = ms;
    }
    const status = normalizeAppointmentStatus(a.status);

    if (countsForRisk(a.status)) {
      risk_flag = true;
    }

    const scanVault =
      options?.includePendingAndCanceledForVault ||
      countsAsBooking(a.status) ||
      status === 'pending';

    if (scanVault && hasVaultedStripeCustomer(a.stripe_customer_id)) {
      has_vaulted_card = true;
    }

    if (!countsAsBooking(a.status)) {
      continue;
    }

    total_bookings += 1;

    if (
      countsForLifetimeValue(a.status, a.booking_time, now) &&
      a.service_price != null &&
      Number.isFinite(a.service_price)
    ) {
      lifetime_value += a.service_price;
    }
  }

  return {
    total_bookings,
    lifetime_value,
    has_vaulted_card,
    risk_flag,
    last_booked_at:
      Number.isFinite(lastBookedMs) && lastBookedMs > Number.NEGATIVE_INFINITY
        ? new Date(lastBookedMs).toISOString()
        : null,
  };
}

interface CrmStatsRow {
  total_bookings: number | string | null;
  lifetime_value: number | string | null;
  has_vaulted_card: boolean | null;
  risk_flag: boolean | null;
  last_booked_at: Date | string | null;
}

function toNumber(value: number | string | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate CRM stats for one client (same SQL as the directory page).
 */
export async function fetchClientCrmStats(
  clientId: string,
  client: { email: string | null; phone: string | null }
): Promise<ClientCrmStats> {
  const { rows } = await sql<CrmStatsRow>`
    SELECT
      MAX(a.created_at) AS last_booked_at,
      COUNT(*) FILTER (
        WHERE COALESCE(LOWER(TRIM(a.status)), '') NOT IN (
          'pending',
          'canceled_by_admin',
          'canceled_by_client',
          'canceled_by_client_late',
          'canceled_by_system'
        )
      )::int AS total_bookings,
      COALESCE(
        SUM(
          CASE
            WHEN a.booking_time IS NOT NULL
              AND a.booking_time < NOW()
              AND COALESCE(LOWER(TRIM(a.status)), '') IN (
                'confirmed',
                'no-show'
              )
            THEN COALESCE(s.price::numeric, 0)
            ELSE 0
          END
        ),
        0
      )::float AS lifetime_value,
      BOOL_OR(
        a.stripe_customer_id IS NOT NULL
        AND TRIM(a.stripe_customer_id) <> ''
      ) AS has_vaulted_card,
      BOOL_OR(
        COALESCE(LOWER(TRIM(a.status)), '') IN (
          'no-show',
          'canceled_by_client_late'
        )
      ) AS risk_flag
    FROM appointments a
    LEFT JOIN LATERAL (
      SELECT s.price
      FROM site_services s
      WHERE s.title = split_part(a.service_name, ' between ', 1)
        AND s.is_active = TRUE
        AND (
          lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
            'classic', 'hybrid', 'volume'
          )
          OR (
            a.booking_time IS NOT NULL
            AND a.end_time IS NOT NULL
            AND s.duration_mins IS NOT NULL
            AND s.duration_mins = GREATEST(
              1,
              ROUND(
                EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
              )
            )::integer
          )
        )
      ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) s ON TRUE
    WHERE
      a.client_id = ${clientId}::uuid
      OR (
        ${client.email}::text IS NOT NULL
        AND a.client_email IS NOT NULL
        AND LOWER(TRIM(a.client_email)) = LOWER(TRIM(${client.email}))
      )
      OR (
        ${client.phone}::text IS NOT NULL
        AND a.client_phone IS NOT NULL
        AND regexp_replace(a.client_phone, '\D', '', 'g') = ${client.phone}
      )
  `;

  const row = rows[0];
  if (!row) return { ...EMPTY_CLIENT_CRM_STATS };

  const lastBookedAt = row.last_booked_at;
  let last_booked_at: string | null = null;
  if (lastBookedAt) {
    const d =
      lastBookedAt instanceof Date ? lastBookedAt : new Date(lastBookedAt);
    if (!Number.isNaN(d.getTime())) last_booked_at = d.toISOString();
  }

  return {
    total_bookings: toNumber(row.total_bookings),
    lifetime_value: toNumber(row.lifetime_value),
    has_vaulted_card: Boolean(row.has_vaulted_card),
    risk_flag: Boolean(row.risk_flag),
    last_booked_at,
  };
}
