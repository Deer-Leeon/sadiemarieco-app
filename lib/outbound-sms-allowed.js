/**
 * Outbound SMS gate.
 *
 * Production: always allowed (unless DISABLE_OUTBOUND_SMS=true hard-kill).
 * Staging: allowed only when studio_settings.staging_outbound_sms_enabled
 *   is true (admin Settings toggle). Default off — Sunday DB resets clear it.
 * Other preview/dev: always blocked.
 *
 * CommonJS so legacy handlers and booking-notifications.js can require() it.
 * Async because staging consults Postgres.
 */

const { sql } = require('@vercel/postgres');

const STUDIO_SETTINGS_ROW_ID = 1;

function isStagingDeployment() {
  if (process.env.APP_ENV === 'staging') return true;
  if (process.env.VERCEL_GIT_COMMIT_REF === 'staging') return true;
  return false;
}

/**
 * @returns {Promise<boolean>}
 */
async function readStagingSmsToggle() {
  try {
    const { rows } = await sql`
      SELECT staging_outbound_sms_enabled
      FROM studio_settings
      WHERE id = ${STUDIO_SETTINGS_ROW_ID}
      LIMIT 1
    `;
    return rows[0]?.staging_outbound_sms_enabled === true;
  } catch (err) {
    console.warn('[outbound-sms-allowed] failed to read staging toggle', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail closed on staging if the column isn't migrated yet.
    return false;
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function isOutboundSmsAllowed() {
  if (isStagingDeployment()) {
    return readStagingSmsToggle();
  }

  if (process.env.DISABLE_OUTBOUND_SMS === 'true') return false;

  // Vercel preview / local — never text real clients.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return false;
  }

  return true;
}

module.exports = {
  isOutboundSmsAllowed,
  isStagingDeployment,
  readStagingSmsToggle,
};
