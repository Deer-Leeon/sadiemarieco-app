/**
 * Local outbound SMS ledger. Written after a successful Twilio send so
 * admin can read the exact body without extra Twilio API calls or fees.
 */

const { sql } = require('@vercel/postgres');
const { parseClientPhone } = require('./client-phone');
const { SMS_TEMPLATE_META } = require('./sms-templates');

const LABEL_ALIASES = Object.freeze({
  no_show: 'no_show_no_charge',
  transactional: 'confirmation',
  '48h': 'reminder_48h',
  '24h': 'reminder_24h',
  '1h': 'reminder_1h',
});

function normalizeTemplateKey(logLabel) {
  const raw = typeof logLabel === 'string' ? logLabel.trim() : '';
  if (raw && SMS_TEMPLATE_META[raw]) return raw;
  const aliased = LABEL_ALIASES[raw];
  if (aliased && SMS_TEMPLATE_META[aliased]) return aliased;
  return raw || 'unknown';
}

function displayName(first, last) {
  return [first, last]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function resolveClient(toE164, bookingUid) {
  if (bookingUid) {
    try {
      const { rows } = await sql`
        SELECT
          a.client_id,
          a.client_first_name,
          a.client_last_name,
          c.first_name,
          c.last_name
        FROM appointments a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.cal_event_id = ${bookingUid}
        LIMIT 1
      `;
      const row = rows[0];
      if (row) {
        const name =
          displayName(row.first_name, row.last_name) ||
          displayName(row.client_first_name, row.client_last_name) ||
          null;
        return {
          id: row.client_id ? String(row.client_id) : null,
          name,
        };
      }
    } catch (err) {
      console.warn('[sms-outbound-log] booking client lookup failed', {
        bookingUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const parsed = parseClientPhone(toE164);
  if (!parsed) return { id: null, name: null };

  try {
    const { rows } = await sql`
      SELECT id, first_name, last_name
      FROM clients
      WHERE phone = ${parsed.e164}
         OR phone = ${parsed.digits}
         OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = ${parsed.digits}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { id: null, name: null };
    return {
      id: String(row.id),
      name: displayName(row.first_name, row.last_name) || null,
    };
  } catch (err) {
    console.warn('[sms-outbound-log] phone client lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { id: null, name: null };
  }
}

/**
 * Fire-and-forget. Never throws; never delays the Twilio send on failure.
 */
async function recordOutboundSms({
  logLabel = null,
  templateKey = null,
  body,
  toE164,
  bookingUid = null,
  twilioSid = null,
}) {
  const text = typeof body === 'string' ? body.trim() : '';
  const to = typeof toE164 === 'string' ? toE164.trim() : '';
  if (!text || !to) return;

  try {
    const key = normalizeTemplateKey(templateKey || logLabel);
    const client = await resolveClient(to, bookingUid);
    await sql`
      INSERT INTO sms_outbound_log (
        template_key,
        body,
        to_e164,
        client_id,
        client_name,
        booking_uid,
        twilio_sid
      )
      VALUES (
        ${key},
        ${text},
        ${to},
        ${client.id},
        ${client.name},
        ${bookingUid ? String(bookingUid).trim() : null},
        ${twilioSid ? String(twilioSid).trim() : null}
      )
    `;
  } catch (err) {
    console.warn('[sms-outbound-log] insert failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function listOutboundSms({ limit = 40, before = null } = {}) {
  const take = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const beforeDate =
    before && !Number.isNaN(new Date(before).getTime())
      ? new Date(before)
      : null;
  const { rows } = beforeDate
    ? await sql`
        SELECT
          id::text AS id,
          created_at,
          template_key,
          body,
          to_e164,
          client_id::text AS client_id,
          client_name,
          booking_uid,
          twilio_sid
        FROM sms_outbound_log
        WHERE created_at < ${beforeDate}
        ORDER BY created_at DESC
        LIMIT ${take}
      `
    : await sql`
        SELECT
          id::text AS id,
          created_at,
          template_key,
          body,
          to_e164,
          client_id::text AS client_id,
          client_name,
          booking_uid,
          twilio_sid
        FROM sms_outbound_log
        ORDER BY created_at DESC
        LIMIT ${take}
      `;

  return rows;
}

function displayTitleForTemplateKey(key) {
  if (key && SMS_TEMPLATE_META[key]) return SMS_TEMPLATE_META[key].title;
  if (key === 'twilio_history') return 'Sent text';
  return key || 'Sent text';
}

function phoneLookupParts(raw) {
  const parsed = parseClientPhone(raw);
  if (parsed) {
    const national =
      parsed.digits.length === 11 && parsed.digits.startsWith('1')
        ? parsed.digits.slice(1)
        : parsed.digits;
    return {
      e164: parsed.e164,
      digits: parsed.digits,
      national,
    };
  }
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return { e164: raw.trim(), digits, national: digits };
}

/**
 * Newest-first texts for one client: rows tagged with client_id, plus
 * anything sent to their current phone (covers log rows written before
 * the client lookup succeeded).
 */
async function listOutboundSmsForClient({
  clientId,
  phone = null,
  limit = 80,
  before = null,
} = {}) {
  const take = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const beforeDate =
    before && !Number.isNaN(new Date(before).getTime())
      ? new Date(before)
      : null;
  const parts = phoneLookupParts(phone);
  const e164 = parts?.e164 || '';
  const digits = parts?.digits || '';
  const national = parts?.national || '';

  const { rows } = beforeDate
    ? await sql`
        SELECT
          id::text AS id,
          created_at,
          template_key,
          body,
          to_e164,
          client_id::text AS client_id,
          client_name,
          booking_uid,
          twilio_sid
        FROM sms_outbound_log
        WHERE created_at < ${beforeDate}
          AND (
            client_id = ${clientId}::uuid
            OR (${e164} <> '' AND to_e164 = ${e164})
            OR (
              ${digits} <> ''
              AND (
                regexp_replace(COALESCE(to_e164, ''), '\\D', '', 'g') = ${digits}
                OR regexp_replace(COALESCE(to_e164, ''), '\\D', '', 'g') = ${national}
              )
            )
          )
        ORDER BY created_at DESC
        LIMIT ${take}
      `
    : await sql`
        SELECT
          id::text AS id,
          created_at,
          template_key,
          body,
          to_e164,
          client_id::text AS client_id,
          client_name,
          booking_uid,
          twilio_sid
        FROM sms_outbound_log
        WHERE
          client_id = ${clientId}::uuid
          OR (${e164} <> '' AND to_e164 = ${e164})
          OR (
            ${digits} <> ''
            AND (
              regexp_replace(COALESCE(to_e164, ''), '\\D', '', 'g') = ${digits}
              OR regexp_replace(COALESCE(to_e164, ''), '\\D', '', 'g') = ${national}
            )
          )
        ORDER BY created_at DESC
        LIMIT ${take}
      `;

  return rows;
}

async function upsertTwilioHistoryRow({
  createdAt,
  body,
  toE164,
  clientId = null,
  clientName = null,
  twilioSid,
}) {
  const text = typeof body === 'string' ? body.trim() : '';
  const to = typeof toE164 === 'string' ? toE164.trim() : '';
  const sid = typeof twilioSid === 'string' ? twilioSid.trim() : '';
  if (!text || !to || !sid) return false;

  const sentAt =
    createdAt instanceof Date
      ? createdAt
      : createdAt
        ? new Date(createdAt)
        : new Date();
  if (Number.isNaN(sentAt.getTime())) return false;

  const { rows: existingSid } = await sql`
    SELECT id::text AS id
    FROM sms_outbound_log
    WHERE twilio_sid = ${sid}
    LIMIT 1
  `;
  if (existingSid[0]) {
    if (clientId) {
      await sql`
        UPDATE sms_outbound_log
        SET
          client_id = COALESCE(client_id, ${clientId}::uuid),
          client_name = COALESCE(client_name, ${clientName})
        WHERE twilio_sid = ${sid}
      `;
    }
    return false;
  }

  const { rows: nearDup } = await sql`
    SELECT id::text AS id
    FROM sms_outbound_log
    WHERE twilio_sid IS NULL
      AND body = ${text}
      AND abs(EXTRACT(EPOCH FROM (created_at - ${sentAt}::timestamptz))) < 180
      AND regexp_replace(COALESCE(to_e164, ''), '\\D', '', 'g')
        = regexp_replace(${to}, '\\D', '', 'g')
    LIMIT 1
  `;
  if (nearDup[0]) {
    await sql`
      UPDATE sms_outbound_log
      SET
        twilio_sid = ${sid},
        client_id = COALESCE(client_id, ${clientId}::uuid),
        client_name = COALESCE(client_name, ${clientName})
      WHERE id = ${nearDup[0].id}::uuid
    `;
    return false;
  }

  try {
    await sql`
      INSERT INTO sms_outbound_log (
        created_at,
        template_key,
        body,
        to_e164,
        client_id,
        client_name,
        booking_uid,
        twilio_sid
      )
      VALUES (
        ${sentAt},
        'twilio_history',
        ${text},
        ${to},
        ${clientId},
        ${clientName},
        NULL,
        ${sid}
      )
    `;
    return true;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String(err.code)
        : '';
    if (code === '23505') return false;
    throw err;
  }
}

function twilioClientOrNull() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  return twilio(accountSid, authToken);
}

function isOutboundTwilioDirection(direction) {
  return String(direction || '').startsWith('outbound');
}

async function existingTwilioSidSet(sids) {
  const known = new Set();
  const unique = [
    ...new Set(
      (Array.isArray(sids) ? sids : [])
        .map((sid) => (typeof sid === 'string' ? sid.trim() : ''))
        .filter(Boolean)
    ),
  ];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const { rows } = await sql.query(
      `SELECT twilio_sid FROM sms_outbound_log WHERE twilio_sid = ANY($1::text[])`,
      [chunk]
    );
    for (const row of rows) {
      if (row.twilio_sid) known.add(row.twilio_sid);
    }
  }
  return known;
}

/**
 * Pull Twilio's stored outbound messages for one destination number and
 * insert any that are missing from the local ledger. Twilio keeps Message
 * records for a limited window (typically about 13 months); older than
 * that will not come back from the API.
 */
async function importTwilioOutboundForPhone({
  toE164,
  clientId = null,
  clientName = null,
  limit = 1000,
} = {}) {
  const parts = phoneLookupParts(toE164);
  if (!parts) {
    return { imported: 0, scanned: 0, skipped: true, reason: 'invalid_phone' };
  }

  const client = twilioClientOrNull();
  if (!client) {
    return { imported: 0, scanned: 0, skipped: true, reason: 'missing_twilio_env' };
  }

  const take = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
  const messages = await client.messages.list({
    to: parts.e164,
    limit: take,
    pageSize: 1000,
  });
  const knownSids = await existingTwilioSidSet(messages.map((msg) => msg.sid));

  let imported = 0;
  let scanned = 0;
  for (const msg of messages) {
    scanned += 1;
    if (!isOutboundTwilioDirection(msg.direction)) continue;
    if (msg.sid && knownSids.has(msg.sid)) continue;
    const inserted = await upsertTwilioHistoryRow({
      createdAt: msg.dateSent || msg.dateCreated,
      body: msg.body,
      toE164: msg.to || parts.e164,
      clientId,
      clientName,
      twilioSid: msg.sid,
    });
    if (inserted) imported += 1;
  }

  return { imported, scanned, skipped: false };
}

/**
 * One-shot backfill: outbound messages on the Twilio account (any studio
 * From number — the studio has used more than one).
 */
async function importAllTwilioOutbound({ limit = 8000 } = {}) {
  const client = twilioClientOrNull();
  if (!client) {
    return { imported: 0, scanned: 0, skipped: true, reason: 'missing_twilio_env' };
  }

  const take = Math.min(Math.max(Number(limit) || 8000, 1), 20000);
  const messages = await client.messages.list({
    limit: take,
    pageSize: 1000,
  });
  const knownSids = await existingTwilioSidSet(messages.map((msg) => msg.sid));

  let imported = 0;
  let scanned = 0;
  for (const msg of messages) {
    scanned += 1;
    if (!isOutboundTwilioDirection(msg.direction)) continue;
    if (msg.sid && knownSids.has(msg.sid)) continue;
    const to = typeof msg.to === 'string' ? msg.to.trim() : '';
    if (!to) continue;
    const resolved = await resolveClient(to, null);
    const inserted = await upsertTwilioHistoryRow({
      createdAt: msg.dateSent || msg.dateCreated,
      body: msg.body,
      toE164: to,
      clientId: resolved.id,
      clientName: resolved.name,
      twilioSid: msg.sid,
    });
    if (inserted) imported += 1;
  }

  return { imported, scanned, skipped: false };
}

module.exports = {
  normalizeTemplateKey,
  displayTitleForTemplateKey,
  recordOutboundSms,
  listOutboundSms,
  listOutboundSmsForClient,
  importTwilioOutboundForPhone,
  importAllTwilioOutbound,
};
