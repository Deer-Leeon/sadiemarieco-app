/**
 * Postgres helpers for phone-keyed client lookups (10- vs 11-digit US variants).
 */

import { sql } from '@vercel/postgres';

import { clientPhoneLookupVariants, normaliseClientPhone } from '@/lib/client-identity';

export interface ClientPhoneRow {
  id: string;
  phone: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  created_at?: string | null;
  has_consented?: boolean;
  consent_form_url?: string | null;
  consent_technician_reviewed_at?: string | Date | null;
  review_request_pending?: boolean | null;
  google_review_noted?: boolean | null;
  google_review_noted_at?: Date | string | null;
  review_request_last_sent_at?: Date | string | null;
}

/** Canonical 11-digit US when parseable; used for new writes. */
export function canonicalClientPhone(raw: unknown): string | null {
  return normaliseClientPhone(raw);
}

export async function findClientRowByPhone(
  canonicalPhone: string
): Promise<ClientPhoneRow | null> {
  for (const variant of clientPhoneLookupVariants(canonicalPhone)) {
    const { rows } = await sql<ClientPhoneRow>`
      SELECT
        id,
        phone,
        first_name,
        last_name,
        email,
        created_at,
        has_consented,
        consent_form_url,
        consent_technician_reviewed_at,
        review_request_pending,
        google_review_noted,
        google_review_noted_at,
        review_request_last_sent_at
      FROM clients
      WHERE phone = ${variant}
      LIMIT 1
    `;
    if (rows[0]?.id) return rows[0];
  }
  return null;
}

export async function findClientIdByPhone(
  canonicalPhone: string
): Promise<string | null> {
  const row = await findClientRowByPhone(canonicalPhone);
  return row?.id ?? null;
}

export async function clientPhoneExistsInDb(
  canonicalPhone: string
): Promise<boolean> {
  return (await findClientIdByPhone(canonicalPhone)) !== null;
}
