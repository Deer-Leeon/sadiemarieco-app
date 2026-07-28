/**
 * Lifetime no-show counter + dismissible attention flag on `clients`.
 *
 * - Count increments on every admin no-show mark (charged or not).
 * - Flag activates only when the no-show is marked without charging.
 * - Flag can be cleared from the client profile; count never decreases.
 */
import { sql } from '@vercel/postgres';

import { sqlPhoneVariants } from '@/lib/client-identity';

export async function recordClientNoShow(opts: {
  clientId: string | null;
  clientPhone: string | null;
  /** True when admin chose "no charge" — reactivates the attention flag. */
  activateFlag: boolean;
}): Promise<{ clientId: string } | { skipped: 'no_client' }> {
  const clientId = await resolveClientId(opts.clientId, opts.clientPhone);
  if (!clientId) {
    console.warn('[client-no-show] no client resolved for no-show record', {
      clientId: opts.clientId,
      hasPhone: Boolean(opts.clientPhone),
      activateFlag: opts.activateFlag,
    });
    return { skipped: 'no_client' };
  }

  if (opts.activateFlag) {
    await sql`
      UPDATE clients
      SET
        no_show_count = no_show_count + 1,
        no_show_flag = TRUE
      WHERE id = ${clientId}::uuid
    `;
  } else {
    await sql`
      UPDATE clients
      SET no_show_count = no_show_count + 1
      WHERE id = ${clientId}::uuid
    `;
  }

  return { clientId };
}

export async function clearClientNoShowFlag(clientId: string): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE clients
    SET no_show_flag = FALSE
    WHERE id = ${clientId}::uuid
  `;
  return (rowCount ?? 0) > 0;
}

async function resolveClientId(
  clientId: string | null,
  clientPhone: string | null
): Promise<string | null> {
  if (clientId) return clientId;
  if (!clientPhone) return null;

  const [phoneV0, phoneV1] = sqlPhoneVariants(clientPhone);
  if (!phoneV0 && !phoneV1) return null;

  const { rows } = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM clients
    WHERE phone IS NOT NULL
      AND (
        regexp_replace(phone, '\D', '', 'g') = ${phoneV0}
        OR regexp_replace(phone, '\D', '', 'g') = ${phoneV1}
      )
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
