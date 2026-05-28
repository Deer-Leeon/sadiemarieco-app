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
      SELECT id, phone, first_name, last_name, email, created_at
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
