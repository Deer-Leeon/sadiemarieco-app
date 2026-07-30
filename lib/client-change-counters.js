/**
 * CJS counter writers + fee free-pass helpers for the Cal webhook.
 * Mirrors `lib/client-no-show.ts`.
 */

const { sql } = require('@vercel/postgres');

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function resolveClientId(clientId, clientPhone) {
  if (clientId) return clientId;
  if (!clientPhone) return null;
  const digits = digitsOnly(clientPhone);
  if (!digits) return null;
  // Match with/without leading country 1 (US) like sqlPhoneVariants.
  const alt =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
        ? `1${digits}`
        : '';

  const { rows } = await sql`
    SELECT id::text AS id
    FROM clients
    WHERE phone IS NOT NULL
      AND (
        regexp_replace(phone, '\D', '', 'g') = ${digits}
        OR (
          ${alt}::text <> ''
          AND regexp_replace(phone, '\D', '', 'g') = ${alt}
        )
      )
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * @param {{ clientId?: string | null, clientPhone?: string | null, action: 'cancel' | 'reschedule', penaltyKind: 'late_half' | 'no_show_full' }} opts
 */
async function recordClientChangeFeeCounters(opts) {
  const clientId = await resolveClientId(
    opts.clientId || null,
    opts.clientPhone || null
  );
  if (!clientId) {
    console.warn('[client-change-counters] no client resolved', {
      hasClientId: Boolean(opts.clientId),
      hasPhone: Boolean(opts.clientPhone),
      action: opts.action,
      penaltyKind: opts.penaltyKind,
    });
    return { skipped: 'no_client' };
  }

  const action = opts.action === 'reschedule' ? 'reschedule' : 'cancel';
  const kind = opts.penaltyKind;

  if (kind === 'late_half') {
    if (action === 'reschedule') {
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
    return { clientId, kind: 'late_change', action };
  }

  if (kind === 'no_show_full') {
    if (action === 'reschedule') {
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
    return { clientId, kind: 'no_show_auto', action };
  }

  return { skipped: 'unknown_kind' };
}

/**
 * Atomically consume free pass. Returns consumed=true only if it was TRUE.
 * @param {'no_show' | 'late_change'} kind
 */
async function consumeFeeWaiveNext(kind, clientId, clientPhone) {
  const resolved = await resolveClientId(clientId || null, clientPhone || null);
  if (!resolved) return { consumed: false, clientId: null };

  if (kind === 'late_change') {
    const { rows } = await sql`
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

  const { rows } = await sql`
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

/** Force waive_next = FALSE after a successful charge. */
async function clearFeeWaiveNext(kind, clientId, clientPhone) {
  const resolved = await resolveClientId(clientId || null, clientPhone || null);
  if (!resolved) return false;

  if (kind === 'late_change') {
    await sql`
      UPDATE clients
      SET late_change_waive_next = FALSE
      WHERE id = ${resolved}::uuid
    `;
    return true;
  }

  await sql`
    UPDATE clients
    SET no_show_waive_next = FALSE
    WHERE id = ${resolved}::uuid
  `;
  return true;
}

module.exports = {
  resolveClientId,
  recordClientChangeFeeCounters,
  consumeFeeWaiveNext,
  clearFeeWaiveNext,
};
