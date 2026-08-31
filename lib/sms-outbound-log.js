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

module.exports = {
  normalizeTemplateKey,
  recordOutboundSms,
  listOutboundSms,
};
