/**
 * Internal consent / intake form — shared types and URL helpers.
 */

export const CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientUuid(value: string): boolean {
  return CLIENT_UUID_RE.test(value.trim());
}

/** Flexible JSON payload for intake answers (expand in the form page). */
export type ConsentFormData = Record<string, unknown>;

export interface ClientIntakeForm {
  id: string;
  client_id: string;
  form_data: ConsentFormData;
  signature_image: string | null;
  /** Public Vercel Blob URL for the flattened, stamped PDF. */
  stamped_pdf_url: string | null;
  submitted_at: string | null;
}

export interface ConsentApiResponse {
  client: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    has_consented: boolean;
  };
  intake: ClientIntakeForm | null;
  submitted: boolean;
}

export function consentFormPath(clientId: string): string {
  return `/consent/${clientId.trim().toLowerCase()}`;
}

/** True when `consent_form_url` / `stamped_pdf_url` is a Vercel Blob (or other) PDF URL. */
export function isStampedConsentPdfUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith('https://') || trimmed.startsWith('http://');
}

export function getPublicSiteBaseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
    'https://www.sadiemarie.co'
  ).replace(/\/$/, '');
}

/** Absolute URL for SMS and external share. */
export function consentFormAbsoluteUrl(clientId: string): string | null {
  const id = clientId.trim().toLowerCase();
  if (!isValidClientUuid(id)) return null;
  return `${getPublicSiteBaseUrl()}${consentFormPath(id)}`;
}
