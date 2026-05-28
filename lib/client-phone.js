/**
 * Shared US phone normalization (CJS) — used by legacy webhook handlers and
 * re-exported from lib/client-identity.ts for TypeScript routes.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

function parseClientPhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    const e164 = `+${digits}`;
    if (!E164_RE.test(e164)) return null;
    return { digits, e164 };
  }

  if (digits.length === 10) {
    return { digits: `1${digits}`, e164: `+1${digits}` };
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return { digits, e164: `+${digits}` };
  }

  return null;
}

function normaliseClientPhone(raw) {
  return parseClientPhone(raw)?.digits ?? null;
}

/** Canonical US storage when possible; otherwise digits-only fallback. */
function normaliseClientPhoneForStorage(raw) {
  const parsed = parseClientPhone(raw);
  if (parsed) return parsed.digits;
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function clientPhoneLookupVariants(digits) {
  const variants = [];
  const add = (v) => {
    if (v && !variants.includes(v)) variants.push(v);
  };
  add(digits);
  if (digits.length === 11 && digits.startsWith('1')) {
    add(digits.slice(1));
  } else if (digits.length === 10) {
    add(`1${digits}`);
  }
  return variants;
}

/** Up to two values for SQL `IN` / OR phone matching. */
function sqlPhoneVariants(phone) {
  const canon = normaliseClientPhoneForStorage(phone) ?? String(phone).replace(/\D/g, '');
  const variants = clientPhoneLookupVariants(canon);
  return [variants[0], variants[1] ?? variants[0]];
}

module.exports = {
  parseClientPhone,
  normaliseClientPhone,
  normaliseClientPhoneForStorage,
  clientPhoneLookupVariants,
  sqlPhoneVariants,
};
