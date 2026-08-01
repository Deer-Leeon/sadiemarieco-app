/**
 * Twilio Lookup v2 — confirm a phone is a real number, and (when SMS is
 * requested) that the line type can typically receive texts.
 */
import twilio from 'twilio';

import { parseClientPhone } from '@/lib/client-identity';

const SMS_CAPABLE_LINE_TYPES = new Set([
  'mobile',
  'fixedVoip',
  'nonFixedVoip',
]);

export type PhoneLookupResult =
  | {
      ok: true;
      e164: string;
      digits: string;
      lineType: string | null;
      valid: true;
    }
  | {
      ok: false;
      error: 'invalid_format' | 'invalid_number' | 'not_sms_capable' | 'lookup_failed';
      message: string;
    };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toE164(raw: string): { e164: string; digits: string } | null {
  const parsed = parseClientPhone(raw);
  if (parsed) return { e164: parsed.e164, digits: parsed.digits };
  return null;
}

/**
 * Validate `raw` with Twilio Lookup.
 * - Always requires Twilio `valid: true` when Lookup succeeds.
 * - When `requireSmsCapable`, rejects landlines / toll-free / etc.
 * - If Twilio credentials are missing, falls back to local US format only.
 * - If Lookup is unreachable, falls back to local format (don't block bookings).
 */
export async function lookupBookingPhone(
  raw: string,
  options?: { requireSmsCapable?: boolean }
): Promise<PhoneLookupResult> {
  const local = toE164(raw);
  if (!local) {
    return {
      ok: false,
      error: 'invalid_format',
      message:
        'Enter a valid US phone number (10 digits, or +1 followed by 10 digits).',
    };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) {
    console.warn(
      '[phone-lookup] TWILIO_ACCOUNT_SID/AUTH_TOKEN missing — format-only check'
    );
    return {
      ok: true,
      e164: local.e164,
      digits: local.digits,
      lineType: null,
      valid: true,
    };
  }

  try {
    const client = twilio(sid, token);
    const result = await client.lookups.v2
      .phoneNumbers(local.e164)
      .fetch({ fields: 'line_type_intelligence' });

    if (result.valid === false) {
      return {
        ok: false,
        error: 'invalid_number',
        message:
          'That phone number does not look real. Please double-check it and try again.',
      };
    }

    const lineType =
      result.lineTypeIntelligence &&
      typeof result.lineTypeIntelligence === 'object' &&
      'type' in result.lineTypeIntelligence
        ? String(
            (result.lineTypeIntelligence as { type?: unknown }).type ?? ''
          ) || null
        : null;

    if (
      options?.requireSmsCapable &&
      lineType &&
      !SMS_CAPABLE_LINE_TYPES.has(lineType)
    ) {
      return {
        ok: false,
        error: 'not_sms_capable',
        message:
          'That number cannot receive texts. Use a mobile number, or continue with an email instead.',
      };
    }

    return {
      ok: true,
      e164: result.phoneNumber || local.e164,
      digits: local.digits,
      lineType,
      valid: true,
    };
  } catch (err) {
    // 20404 / not found → treat as invalid number
    const msg = errorMessage(err);
    if (/20404|not found|was not found/i.test(msg)) {
      return {
        ok: false,
        error: 'invalid_number',
        message:
          'That phone number does not look real. Please double-check it and try again.',
      };
    }

    console.warn('[phone-lookup] Twilio Lookup failed — format-only fallback', {
      error: msg,
    });
    return {
      ok: true,
      e164: local.e164,
      digits: local.digits,
      lineType: null,
      valid: true,
    };
  }
}
