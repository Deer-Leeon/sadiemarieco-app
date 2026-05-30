/**
 * POST /api/webhooks/tally
 *
 * Receives Tally.so FORM_RESPONSE webhooks and marks the CRM client as
 * consented. Expects a hidden field `client_id` (UUID) on the Tally form.
 */

import { sql } from '@vercel/postgres';

import {
  buildTallySubmissionPreviewUrl,
  getServerTallyFormId,
} from '@/lib/tally-consent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TallyField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  value?: unknown;
}

function fieldKey(field: TallyField): string {
  return typeof field.key === 'string' ? field.key.trim() : '';
}

function fieldLabel(field: TallyField): string {
  return typeof field.label === 'string' ? field.label.trim() : '';
}

function fieldValue(field: TallyField): string {
  if (field.value === undefined || field.value === null) return '';
  if (typeof field.value === 'string') return field.value.trim();
  if (typeof field.value === 'number' || typeof field.value === 'boolean') {
    return String(field.value).trim();
  }
  return '';
}

function isClientIdField(field: TallyField): boolean {
  const key = fieldKey(field).toLowerCase();
  const label = fieldLabel(field).toLowerCase();
  return key === 'client_id' || label === 'client_id';
}

/**
 * Resolve the CRM client UUID from Tally's `data.fields` array.
 */
function extractClientId(fields: TallyField[]): string | null {
  for (const field of fields) {
    if (!isClientIdField(field)) continue;
    const value = fieldValue(field);
    if (UUID_RE.test(value)) return value.toLowerCase();
  }

  for (const field of fields) {
    const value = fieldValue(field);
    if (!UUID_RE.test(value)) continue;
    const key = fieldKey(field).toLowerCase();
    const label = fieldLabel(field).toLowerCase();
    if (key.includes('client_id') || label.includes('client_id')) {
      return value.toLowerCase();
    }
  }

  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTallyPayload(body: unknown): {
  clientId: string | null;
  responseId: string | null;
  submissionPreviewUrl: string | null;
  formId: string | null;
} {
  if (!body || typeof body !== 'object') {
    return {
      clientId: null,
      responseId: null,
      submissionPreviewUrl: null,
      formId: null,
    };
  }

  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return {
      clientId: null,
      responseId: null,
      submissionPreviewUrl: null,
      formId: null,
    };
  }

  const record = data as {
    responseId?: unknown;
    formId?: unknown;
    submissionPreviewUrl?: unknown;
    fields?: unknown;
  };

  const rawFields = record.fields;
  const fields = Array.isArray(rawFields)
    ? (rawFields as TallyField[])
    : [];

  return {
    clientId: extractClientId(fields),
    responseId: nonEmptyString(record.responseId),
    submissionPreviewUrl: nonEmptyString(record.submissionPreviewUrl),
    formId: nonEmptyString(record.formId),
  };
}

function resolveConsentFormUrlForStorage(opts: {
  submissionPreviewUrl: string | null;
  responseId: string | null;
  formId: string | null;
}): string {
  const preview = opts.submissionPreviewUrl;
  if (preview && /^https?:\/\//i.test(preview)) {
    return preview;
  }

  if (opts.responseId) {
    const tallyFormId = opts.formId || getServerTallyFormId() || null;
    const built = buildTallySubmissionPreviewUrl(
      opts.responseId,
      tallyFormId ?? undefined
    );
    if (built) return built;
    return `Tally Response ID: ${opts.responseId}`;
  }

  return 'Tally Response ID: (unknown)';
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[api/webhooks/tally] invalid JSON body:', err);
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { clientId, responseId, submissionPreviewUrl, formId } =
    parseTallyPayload(body);
  if (!clientId) {
    console.warn('[api/webhooks/tally] missing or invalid client_id in payload');
    return new Response('Missing client_id', { status: 400 });
  }

  const consentFormUrl = resolveConsentFormUrlForStorage({
    submissionPreviewUrl,
    responseId,
    formId,
  });

  try {
    const { rowCount } = await sql`
      UPDATE clients
      SET
        has_consented = true,
        consent_form_url = ${consentFormUrl}
      WHERE id = ${clientId}::uuid
    `;

    if (!rowCount) {
      console.warn('[api/webhooks/tally] client not found', { clientId });
      return new Response('Client not found', { status: 404 });
    }

    console.log('[api/webhooks/tally] consent recorded', {
      clientId,
      responseId,
    });
    return new Response('Success', { status: 200 });
  } catch (err) {
    console.error('[api/webhooks/tally] database update failed:', err);
    return new Response('Internal server error', { status: 500 });
  }
}
