/**
 * Lifetime no-show + late-change counters on `clients`.
 *
 * Totals never decrease. Breakdown columns must stay in sync:
 *   no_show_count = admin + auto_cancel + auto_reschedule
 *   late_change_count = late_cancel + late_reschedule
 *
 * Fee free passes:
 *   no_show_waive_next / late_change_waive_next DEFAULT TRUE
 *   TRUE  = next eligible event is waived
 *   FALSE = will be charged next time
 */
import { sql } from '@vercel/postgres';

import { sqlPhoneVariants } from '@/lib/client-identity';

export type ChangeFeeAction = 'cancel' | 'reschedule';
export type FeeWaiveKind = 'no_show' | 'late_change';

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

/**
 * Atomically consume a free pass. Returns true only if the pass was still
 * available (TRUE → FALSE).
 */
export async function consumeFeeWaiveNext(
  kind: FeeWaiveKind,
  clientId: string | null,
  clientPhone: string | null = null
): Promise<
  { consumed: true; clientId: string } | { consumed: false; clientId: string | null }
> {
  const resolved = await resolveClientId(clientId, clientPhone);
  if (!resolved) return { consumed: false, clientId: null };

  if (kind === 'late_change') {
    const { rows } = await sql<{ id: string }>`
      UPDATE clients
      SET late_change_waive_next = FALSE
      WHERE id = ${resolved}::uuid
        AND late_change_waive_next = TRUE
      RETURNING id::text AS id
    `;
    return rows[0]
      ? { consumed: true, clientId: rows[0].id }
      : { consumed: false, clientId: resolved };
  }

  const { rows } = await sql<{ id: string }>`
    UPDATE clients
    SET no_show_waive_next = FALSE
    WHERE id = ${resolved}::uuid
      AND no_show_waive_next = TRUE
    RETURNING id::text AS id
  `;
  return rows[0]
    ? { consumed: true, clientId: rows[0].id }
    : { consumed: false, clientId: resolved };
}

/** Force waive_next = FALSE (e.g. after admin Charge). */
export async function clearFeeWaiveNext(
  kind: FeeWaiveKind,
  clientId: string | null,
  clientPhone: string | null = null
): Promise<boolean> {
  const resolved = await resolveClientId(clientId, clientPhone);
  if (!resolved) return false;

  if (kind === 'late_change') {
    const { rowCount } = await sql`
      UPDATE clients
      SET late_change_waive_next = FALSE
      WHERE id = ${resolved}::uuid
    `;
    return (rowCount ?? 0) > 0;
  }

  const { rowCount } = await sql`
    UPDATE clients
    SET no_show_waive_next = FALSE
    WHERE id = ${resolved}::uuid
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Grant a free pass (waive_next = TRUE). Returns client contact for SMS.
 */
export async function grantFeeWaiveNext(
  kind: FeeWaiveKind,
  clientId: string
): Promise<{
  granted: boolean;
  alreadyHad: boolean;
  phone: string | null;
  smsOptIn: boolean | null;
} | null> {
  const { rows: before } = await sql<{
    no_show_waive_next: boolean;
    late_change_waive_next: boolean;
    phone: string | null;
  }>`
    SELECT
      no_show_waive_next,
      late_change_waive_next,
      phone
    FROM clients
    WHERE id = ${clientId}::uuid
    LIMIT 1
  `;
  const row = before[0];
  if (!row) return null;

  const alreadyHad =
    kind === 'late_change'
      ? Boolean(row.late_change_waive_next)
      : Boolean(row.no_show_waive_next);

  if (kind === 'late_change') {
    await sql`
      UPDATE clients
      SET late_change_waive_next = TRUE
      WHERE id = ${clientId}::uuid
    `;
  } else {
    await sql`
      UPDATE clients
      SET no_show_waive_next = TRUE
      WHERE id = ${clientId}::uuid
    `;
  }

  const { rows: optRows } = await sql<{ sms_opt_in: boolean | null }>`
    SELECT sms_opt_in
    FROM appointments
    WHERE client_id = ${clientId}::uuid
      AND sms_opt_in IS NOT NULL
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `;

  return {
    granted: true,
    alreadyHad,
    phone: row.phone,
    smsOptIn: optRows[0]?.sms_opt_in ?? null,
  };
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
