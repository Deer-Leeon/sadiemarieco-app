/**
 * Outbound SMS is production-only. Staging/preview must never text clients.
 *
 * CommonJS so legacy handlers and booking-notifications.js can require() it.
 */

function isOutboundSmsAllowed() {
  if (process.env.DISABLE_OUTBOUND_SMS === 'true') return false;
  if (process.env.APP_ENV === 'staging') return false;
  if (process.env.VERCEL_GIT_COMMIT_REF === 'staging') return false;
  // Vercel sets VERCEL_ENV to "production" | "preview" | "development"
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return false;
  }
  return true;
}

module.exports = { isOutboundSmsAllowed };
