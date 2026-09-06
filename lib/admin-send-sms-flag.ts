/**
 * Admin cancel/reschedule: `send_sms` defaults to true unless explicitly false.
 * Skip-intent keys let Cal's BOOKING_RESCHEDULED webhook honor an unchecked
 * checkbox when the embed completes before POST /reschedule.
 */

export function parseSendSmsFlag(raw: unknown): boolean {
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') {
    return false;
  }
  return true;
}

/** True unless the body explicitly sets `send_sms` / `sendSms` to false. */
export function parseSendSmsFromBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true;
  const rec = body as Record<string, unknown>;
  if ('send_sms' in rec) return parseSendSmsFlag(rec.send_sms);
  if ('sendSms' in rec) return parseSendSmsFlag(rec.sendSms);
  return true;
}

