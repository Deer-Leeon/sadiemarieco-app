/**
 * Tally.so consent form URLs — shared by admin UI and the Tally webhook.
 *
 * Form (fill):  https://tally.so/r/<slug>?client_id=<uuid>
 * Preview:      https://tally.so/forms/<slug>/submissions/<responseId>/preview
 */

const STORED_RESPONSE_ID_RE = /^Tally Response ID:\s*(.+)$/i;

export function getPublicTallyFormId(): string {
  return (process.env.NEXT_PUBLIC_TALLY_CONSENT_FORM_ID || '').trim();
}

export function getServerTallyFormId(): string {
  return (
    process.env.TALLY_CONSENT_FORM_ID ||
    process.env.NEXT_PUBLIC_TALLY_CONSENT_FORM_ID ||
    ''
  ).trim();
}

export function buildTallyConsentFormUrl(
  clientId: string,
  formId?: string
): string | null {
  const id = clientId.trim();
  const slug = (formId ?? getPublicTallyFormId()).trim();
  if (!id || !slug) return null;
  return `https://tally.so/r/${slug}?client_id=${encodeURIComponent(id)}`;
}

export function buildTallySubmissionPreviewUrl(
  responseId: string,
  formId?: string
): string | null {
  const resp = responseId.trim();
  const slug = (formId ?? getServerTallyFormId()).trim();
  if (!resp || !slug) return null;
  return `https://tally.so/forms/${slug}/submissions/${encodeURIComponent(resp)}/preview`;
}

/** Legacy webhook value before we stored full preview URLs. */
export function parseStoredTallyResponseId(
  consentFormUrl: string | null
): string | null {
  if (!consentFormUrl) return null;
  const trimmed = consentFormUrl.trim();
  const match = trimmed.match(STORED_RESPONSE_ID_RE);
  if (!match?.[1]) return null;
  const id = match[1].trim();
  return id && id !== '(unknown)' ? id : null;
}

/** Read-only link to the signed submission (State B). */
export function resolveConsentViewUrl(
  consentFormUrl: string | null,
  formId?: string
): string | null {
  if (!consentFormUrl) return null;
  const trimmed = consentFormUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const responseId = parseStoredTallyResponseId(trimmed);
  if (responseId) {
    return buildTallySubmissionPreviewUrl(responseId, formId);
  }
  return null;
}
