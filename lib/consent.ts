/**
 * Internal consent / intake form — shared types and URL helpers.
 */

export const CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientUuid(value: string): boolean {
  return CLIENT_UUID_RE.test(value.trim());
}

import type { ConsentFormData } from '@/app/consent/[clientId]/consent-form-config';

export type { ConsentFormData };

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
    /** Blob PDF URL after stamping, or legacy `/consent/…` path. */
    consent_form_url: string | null;
  };
  intake: ClientIntakeForm | null;
  submitted: boolean;
  /** Set when a submitted form has no stamped PDF yet (e.g. Blob token or template issue). */
  stamp_error?: string | null;
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

/** Prefer intake `stamped_pdf_url`, then client `consent_form_url` when both are Blob URLs. */
export function resolveConsentPdfUrl(
  intake: ClientIntakeForm | null | undefined,
  consentFormUrl?: string | null
): string | null {
  if (isStampedConsentPdfUrl(intake?.stamped_pdf_url)) {
    return intake!.stamped_pdf_url!.trim();
  }
  if (isStampedConsentPdfUrl(consentFormUrl)) {
    return consentFormUrl!.trim();
  }
  return null;
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
