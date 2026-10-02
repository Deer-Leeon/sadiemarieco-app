/**
 * Short-lived mark that an admin is moving this visit right now.
 * Cal copies booking metadata onto later client reschedules, so
 * `manual_admin_booking` cannot mean "the admin did this move".
 */

const { sql } = require('@vercel/postgres');

const INTENT_PREFIX = 'admin_reschedule_intent:';

function intentKey(appointmentId) {
  const id = appointmentId == null ? '' : String(appointmentId).trim();
  return id ? `${INTENT_PREFIX}${id}` : '';
}

async function markAdminRescheduleIntent(appointmentId) {
  const key = intentKey(appointmentId);
  if (!key) return;
  await sql`
    INSERT INTO webhook_events (booking_uid, processed_at)
    VALUES (${key}, NOW())
    ON CONFLICT (booking_uid)
    DO UPDATE SET processed_at = NOW()
  `;
}

/**
 * True only when an admin reschedule of this visit was started in the
 * last 15 minutes. The claim is removed either way.
 */
async function consumeAdminRescheduleIntent(appointmentId) {
  const key = intentKey(appointmentId);
  if (!key) return false;
  const { rows } = await sql`
    DELETE FROM webhook_events
    WHERE booking_uid = ${key}
      AND processed_at > NOW() - INTERVAL '15 minutes'
    RETURNING booking_uid
  `;
  if (rows.length === 0) {
    await sql`DELETE FROM webhook_events WHERE booking_uid = ${key}`;
  }
  return rows.length > 0;
}

module.exports = {
  markAdminRescheduleIntent,
  consumeAdminRescheduleIntent,
};
