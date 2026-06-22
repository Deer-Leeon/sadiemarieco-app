/**
 * Extract the client's "Additional notes" from a Cal.com booking payload.
 * Cal ships several shapes across webhook + API versions.
 */

const MAX_LEN = 4000;

const NOTE_RESPONSE_KEYS = [
  'notes',
  'additionalNotes',
  'additional_notes',
  'bookingNotes',
  'booking_notes',
];

function unwrap(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object' && typeof val.value === 'string') {
    return val.value.trim();
  }
  if (typeof val === 'object' && val.value != null) {
    return String(val.value).trim();
  }
  return String(val).trim();
}

function clampNotes(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
}

function extractFromResponsesObject(responses) {
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return null;
  }
  for (const key of NOTE_RESPONSE_KEYS) {
    const value = clampNotes(unwrap(responses[key]));
    if (value) return value;
  }
  return null;
}

function extractFromResponsesArray(responses) {
  if (!Array.isArray(responses)) return null;
  for (const item of responses) {
    if (!item || typeof item !== 'object') continue;
    const name = String(
      item.name || item.field || item.identifier || item.slug || '',
    ).toLowerCase();
    if (
      name === 'notes' ||
      (name.includes('additional') && name.includes('note'))
    ) {
      const value = clampNotes(unwrap(item.value ?? item));
      if (value) return value;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {string | null}
 */
function extractCalBookingNotes(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const responses = payload.responses;
  const fromObject = extractFromResponsesObject(responses);
  if (fromObject) return fromObject;

  const fromArray = extractFromResponsesArray(responses);
  if (fromArray) return fromArray;

  const bookingFields = payload.bookingFieldsResponses;
  const fromFields = extractFromResponsesObject(bookingFields);
  if (fromFields) return fromFields;

  return clampNotes(unwrap(payload.description));
}

module.exports = {
  extractCalBookingNotes,
  clampNotes,
};
