/**
 * Extract the client's "Additional notes" from a Cal.com booking payload.
 * Cal ships several shapes across webhook + API versions.
 *
 * Important: Cal always includes a `responses.notes` object
 * (`{ label, isHidden }`) even when the client left notes blank and
 * there is no `value`. Coercing that object with `String(...)` yields
 * the literal `"[object Object]"` — which is how we previously polluted
 * `appointments.booking_notes`. Never stringify raw objects.
 */

const MAX_LEN = 4000;

const NOTE_RESPONSE_KEYS = [
  'notes',
  'additionalNotes',
  'additional_notes',
  'bookingNotes',
  'booking_notes',
];

/**
 * Pull a human-readable string out of Cal's nested response wrappers.
 * Returns '' when the value is missing, blank, or not text.
 *
 * @param {unknown} val
 * @param {number} [depth]
 * @returns {string}
 */
function unwrap(val, depth = 0) {
  if (val == null) return '';
  if (depth > 4) return '';

  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Guard against previously-corrupted writes / nested String(obj).
    if (!trimmed || trimmed === '[object Object]') return '';
    return trimmed;
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }

  if (typeof val !== 'object' || Array.isArray(val)) {
    return '';
  }

  // Cal field wrapper: { label, value, isHidden }
  if ('value' in val) {
    return unwrap(/** @type {{ value: unknown }} */ (val).value, depth + 1);
  }

  // Occasional shapes: { text } / { notes } / { content }
  // Do not unwrap `description` — Cal uses that for the event-type blurb.
  for (const key of ['text', 'notes', 'content']) {
    if (key in val) {
      const nested = unwrap(
        /** @type {Record<string, unknown>} */ (val)[key],
        depth + 1
      );
      if (nested) return nested;
    }
  }

  // Object with only metadata (label / isHidden) and no text — treat as empty.
  return '';
}

/**
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
function clampNotes(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed === '[object Object]') return null;
  return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
}

/**
 * @param {unknown} responses
 * @returns {string | null}
 */
function extractFromResponsesObject(responses) {
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return null;
  }
  for (const key of NOTE_RESPONSE_KEYS) {
    const value = clampNotes(
      unwrap(/** @type {Record<string, unknown>} */ (responses)[key])
    );
    if (value) return value;
  }
  return null;
}

/**
 * @param {unknown} responses
 * @returns {string | null}
 */
function extractFromResponsesArray(responses) {
  if (!Array.isArray(responses)) return null;
  for (const item of responses) {
    if (!item || typeof item !== 'object') continue;
    const name = String(
      /** @type {Record<string, unknown>} */ (item).name ||
        /** @type {Record<string, unknown>} */ (item).field ||
        /** @type {Record<string, unknown>} */ (item).identifier ||
        /** @type {Record<string, unknown>} */ (item).slug ||
        ''
    ).toLowerCase();
    if (
      name === 'notes' ||
      (name.includes('additional') && name.includes('note'))
    ) {
      const value = clampNotes(
        unwrap(
          /** @type {Record<string, unknown>} */ (item).value ?? item
        )
      );
      if (value) return value;
    }
  }
  return null;
}

/**
 * Compact whitespace for equality checks against catalogue copy.
 * @param {string} text
 * @returns {string}
 */
function compactText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Cal's booking `description` is the event-type blurb, not client notes.
 * Reject extracted text that is that blurb (or a nested eventType.description).
 *
 * @param {string} notes
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function notesMatchEventTypeDescription(notes, payload) {
  const compact = compactText(notes);
  const eventType =
    payload.eventType &&
    typeof payload.eventType === 'object' &&
    !Array.isArray(payload.eventType)
      ? /** @type {Record<string, unknown>} */ (payload.eventType)
      : null;
  const candidates = [payload.description, eventType && eventType.description];
  for (const candidate of candidates) {
    const text = clampNotes(typeof candidate === 'string' ? candidate : '');
    if (text && compactText(text) === compact) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {string | null}
 */
function extractCalBookingNotes(payload) {
  if (!payload || typeof payload !== 'object') return null;

  /** @type {string | null} */
  let notes = null;

  // Top-level string Cal still sends on many webhook versions.
  notes = clampNotes(
    unwrap(payload.additionalNotes ?? payload.additional_notes)
  );

  if (!notes) {
    notes = extractFromResponsesObject(payload.responses);
  }
  if (!notes) {
    notes = extractFromResponsesArray(payload.responses);
  }
  if (!notes) {
    notes = extractFromResponsesObject(payload.bookingFieldsResponses);
  }

  // Never persist the event-type / catalogue description as notes,
  // even if Cal copied it onto additionalNotes.
  if (notes && notesMatchEventTypeDescription(notes, payload)) {
    return null;
  }

  return notes;
}

/**
 * Normalize a value already stored on `appointments.booking_notes`
 * for display. Hides the historical `"[object Object]"` corruption.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeStoredBookingNotes(raw) {
  return clampNotes(typeof raw === 'string' ? raw : unwrap(raw));
}

/**
 * Client "Additional notes" only. If Cal previously stored the
 * event-type / catalogue description as booking notes, hide it.
 *
 * @param {unknown} raw
 * @param {unknown} [serviceDescription]
 * @returns {string | null}
 */
function clientBookingNotesForDisplay(raw, serviceDescription) {
  const notes = normalizeStoredBookingNotes(raw);
  if (!notes) return null;
  const description = clampNotes(
    typeof serviceDescription === 'string' ? serviceDescription : null
  );
  if (!description) return notes;
  if (compactText(notes) === compactText(description)) {
    return null;
  }
  return notes;
}

module.exports = {
  extractCalBookingNotes,
  clampNotes,
  normalizeStoredBookingNotes,
  clientBookingNotesForDisplay,
  unwrap,
};
