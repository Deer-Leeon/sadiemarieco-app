import 'server-only';

import { sql } from '@vercel/postgres';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppointmentId(raw: string): boolean {
  if (UUID_RE.test(raw)) return true;
  const asInt = Number(raw);
  return Number.isSafeInteger(asInt) && String(asInt) === raw;
}

export interface SameDayUnsettledVisit {
  id: string;
  cal_booking_uid: string | null;
  booking_time: string | null;
  end_time: string | null;
  service_name: string | null;
  quoted_service_price_cents: number | null;
  status: string | null;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quotedCents(visit: SameDayUnsettledVisit): number {
  const raw = Number(visit.quoted_service_price_cents);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

export function parseAdditionalAppointmentIds(
  raw: unknown,
  primaryId: string
): string[] | { error: string; message: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return {
      error: 'invalid_additional_appointments',
      message: 'additional_appointment_ids must be an array of appointment ids.',
    };
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !isAppointmentId(value)) {
      return {
        error: 'invalid_additional_appointments',
        message: 'Each additional appointment id must be a valid appointment id.',
      };
    }
    if (value === primaryId || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

export async function findSameDayUnsettledSiblings(
  primaryId: string
): Promise<SameDayUnsettledVisit[]> {
  if (!isAppointmentId(primaryId)) return [];

  const { rows } = await sql<SameDayUnsettledVisit>`
    SELECT
      sib.id::text AS id,
      sib.cal_event_id AS cal_booking_uid,
      sib.booking_time,
      sib.end_time,
      sib.service_name,
      sib.quoted_service_price_cents,
      sib.status
    FROM appointments primary_apt
    JOIN appointments sib
      ON sib.id::text <> primary_apt.id::text
     AND sib.status = 'confirmed'
     AND sib.booking_time IS NOT NULL
     AND primary_apt.booking_time IS NOT NULL
     AND (sib.booking_time AT TIME ZONE 'America/Denver')::date
       = (primary_apt.booking_time AT TIME ZONE 'America/Denver')::date
     AND (
       (
         primary_apt.client_id IS NOT NULL
         AND sib.client_id IS NOT NULL
         AND sib.client_id = primary_apt.client_id
       )
       OR (
         regexp_replace(COALESCE(primary_apt.client_phone, ''), '\D', '', 'g') <> ''
         AND regexp_replace(COALESCE(sib.client_phone, ''), '\D', '', 'g') <> ''
         AND (
           regexp_replace(primary_apt.client_phone, '\D', '', 'g')
             = regexp_replace(sib.client_phone, '\D', '', 'g')
           OR regexp_replace(primary_apt.client_phone, '\D', '', 'g')
             = '1' || regexp_replace(sib.client_phone, '\D', '', 'g')
           OR regexp_replace(sib.client_phone, '\D', '', 'g')
             = '1' || regexp_replace(primary_apt.client_phone, '\D', '', 'g')
         )
       )
       OR (
         NULLIF(lower(trim(COALESCE(primary_apt.client_first_name, ''))), '') IS NOT NULL
         AND NULLIF(lower(trim(COALESCE(primary_apt.client_last_name, ''))), '') IS NOT NULL
         AND lower(trim(COALESCE(sib.client_first_name, '')))
           = lower(trim(COALESCE(primary_apt.client_first_name, '')))
         AND lower(trim(COALESCE(sib.client_last_name, '')))
           = lower(trim(COALESCE(primary_apt.client_last_name, '')))
       )
     )
    WHERE primary_apt.id::text = ${primaryId}
      AND NOT EXISTS (
        SELECT 1
        FROM appointment_payments p
        WHERE p.appointment_id = sib.id::text
          AND (
            p.status = 'succeeded'
            OR (
              p.payment_kind = 'service_payment'
              AND p.status IN ('pending', 'processing')
            )
          )
      )
    ORDER BY sib.booking_time ASC, sib.id::text ASC
  `;
  return rows.map((row) => ({
    ...row,
    booking_time: toIsoTimestamp(row.booking_time),
    end_time: toIsoTimestamp(row.end_time),
  }));
}

export async function resolveAdditionalUnsettledVisits(
  primaryId: string,
  additionalIds: string[]
): Promise<
  | { ok: true; visits: SameDayUnsettledVisit[] }
  | { ok: false; error: string; message: string }
> {
  if (additionalIds.length === 0) return { ok: true, visits: [] };

  const siblings = await findSameDayUnsettledSiblings(primaryId);
  const byId = new Map(siblings.map((visit) => [visit.id, visit]));
  const visits: SameDayUnsettledVisit[] = [];
  for (const id of additionalIds) {
    const visit = byId.get(id);
    if (!visit) {
      return {
        ok: false,
        error: 'invalid_additional_appointments',
        message:
          'Additional appointments must be unpaid confirmed visits for this client on the same day.',
      };
    }
    visits.push(visit);
  }
  return { ok: true, visits };
}

/** Leftover pennies go to the primary visit so the parts sum to `totalCents`. */
export function splitChargeAcrossQuoted(
  items: { id: string; quotedCents: number }[],
  totalCents: number,
  primaryId: string
): Map<string, number> {
  const shares = new Map<string, number>();
  if (items.length === 0) return shares;
  const safeTotal = Number.isSafeInteger(totalCents) && totalCents >= 0 ? totalCents : 0;
  const quotedSum = items.reduce((sum, item) => sum + Math.max(0, item.quotedCents), 0);

  if (quotedSum <= 0) {
    for (const item of items) shares.set(item.id, 0);
    shares.set(primaryId, safeTotal);
    return shares;
  }

  let allocated = 0;
  for (const item of items) {
    const share = Math.floor((safeTotal * Math.max(0, item.quotedCents)) / quotedSum);
    shares.set(item.id, share);
    allocated += share;
  }
  const remainder = safeTotal - allocated;
  shares.set(primaryId, (shares.get(primaryId) ?? 0) + remainder);
  return shares;
}

export function sumQuotedCents(
  primaryQuoted: number,
  extras: SameDayUnsettledVisit[]
): number {
  return (
    Math.max(0, primaryQuoted) + extras.reduce((sum, visit) => sum + quotedCents(visit), 0)
  );
}

export function quotedCentsForVisit(visit: SameDayUnsettledVisit): number {
  return quotedCents(visit);
}
