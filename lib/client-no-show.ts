/**
 * Lifetime no-show + late-change counters on `clients`.
 *
 * Totals never decrease. Breakdown columns must stay in sync:
 *   no_show_count = admin + auto_cancel + auto_reschedule
 *   late_change_count = late_cancel + late_reschedule
 */
import { sql } from '@vercel/postgres';

import { sqlPhoneVariants } from '@/lib/client-identity';

export type ChangeFeeAction = 'cancel' | 'reschedule';

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
        no_show_admin_count = no_show_admin_count + 1,
        no_show_flag = TRUE
      WHERE id = ${clientId}::uuid
    `;
  } else {
    await sql`
      UPDATE clients
      SET
        no_show_count = no_show_count + 1,
        no_show_admin_count = no_show_admin_count + 1
      WHERE id = ${clientId}::uuid
    `;
  }

  return { clientId };
}

/**
 * Under-2h client cancel/reschedule that charged 100% (counts as no-show).
 */
export async function recordClientAutoNoShow(opts: {
  clientId: string | null;
  clientPhone: string | null;
  action: ChangeFeeAction;
}): Promise<{ clientId: string } | { skipped: 'no_client' }> {
  const clientId = await resolveClientId(opts.clientId, opts.clientPhone);
  if (!clientId) {
    console.warn('[client-no-show] no client resolved for auto no-show', {
      clientId: opts.clientId,
      hasPhone: Boolean(opts.clientPhone),
      action: opts.action,
    });
    return { skipped: 'no_client' };
  }

  if (opts.action === 'reschedule') {
    await sql`
      UPDATE clients
      SET
        no_show_count = no_show_count + 1,
        no_show_auto_reschedule_count = no_show_auto_reschedule_count + 1
      WHERE id = ${clientId}::uuid
    `;
  } else {
    await sql`
      UPDATE clients
      SET
        no_show_count = no_show_count + 1,
        no_show_auto_cancel_count = no_show_auto_cancel_count + 1
      WHERE id = ${clientId}::uuid
    `;
  }

  return { clientId };
}

/**
 * 2h–24h client cancel/reschedule that charged 50% (Late-Change).
 */
export async function recordClientLateChange(opts: {
  clientId: string | null;
  clientPhone: string | null;
  action: ChangeFeeAction;
}): Promise<{ clientId: string } | { skipped: 'no_client' }> {
  const clientId = await resolveClientId(opts.clientId, opts.clientPhone);
  if (!clientId) {
    console.warn('[client-no-show] no client resolved for late change', {
      clientId: opts.clientId,
      hasPhone: Boolean(opts.clientPhone),
      action: opts.action,
    });
    return { skipped: 'no_client' };
  }

  if (opts.action === 'reschedule') {
    await sql`
      UPDATE clients
      SET
        late_change_count = late_change_count + 1,
        late_change_reschedule_count = late_change_reschedule_count + 1
      WHERE id = ${clientId}::uuid
    `;
  } else {
    await sql`
      UPDATE clients
      SET
        late_change_count = late_change_count + 1,
        late_change_cancel_count = late_change_cancel_count + 1
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

export async function resolveClientId(
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
