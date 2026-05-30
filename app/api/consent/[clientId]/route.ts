/**
 * GET  /api/consent/[clientId] — intake status + saved answers
 * POST /api/consent/[clientId] — submit intake (once per client)
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import {
  isValidClientUuid,
  type ClientIntakeForm,
  type ConsentApiResponse,
  type ConsentFormData,
} from '@/lib/consent';
import { stampConsentPDF } from '@/lib/pdf-stamper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ClientRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  has_consented: boolean;
}

interface IntakeRow {
  id: string;
  client_id: string;
  form_data: ConsentFormData;
  signature_image: string | null;
  stamped_pdf_url: string | null;
  submitted_at: Date | string | null;
}

interface RouteContext {
  params: Promise<{ clientId: string }>;
}

function rowToIntake(row: IntakeRow): ClientIntakeForm {
  const submittedAt = row.submitted_at;
  return {
    id: row.id,
    client_id: row.client_id,
    form_data:
      row.form_data && typeof row.form_data === 'object' && !Array.isArray(row.form_data)
        ? row.form_data
        : {},
    signature_image: row.signature_image,
    stamped_pdf_url: row.stamped_pdf_url ?? null,
    submitted_at:
      submittedAt instanceof Date
        ? submittedAt.toISOString()
        : submittedAt
          ? String(submittedAt)
          : null,
  };
}

function buildResponse(client: ClientRow, intake: IntakeRow | undefined): ConsentApiResponse {
  const intakeForm = intake ? rowToIntake(intake) : null;
  const submitted = Boolean(
    client.has_consented || (intakeForm?.submitted_at && intakeForm.submitted_at.length > 0)
  );
  return {
    client: {
      id: client.id,
      first_name: client.first_name,
      last_name: client.last_name,
      phone: client.phone,
      email: client.email,
      has_consented: Boolean(client.has_consented),
    },
    intake: intakeForm,
    submitted,
  };
}

async function loadClient(clientId: string): Promise<ClientRow | null> {
  const { rows } = await sql<ClientRow>`
    SELECT id, first_name, last_name, phone, email, has_consented
    FROM clients
    WHERE id = ${clientId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadIntake(clientId: string): Promise<IntakeRow | undefined> {
  const { rows } = await sql<IntakeRow>`
    SELECT id, client_id, form_data, signature_image, stamped_pdf_url, submitted_at
    FROM client_intake_forms
    WHERE client_id = ${clientId}::uuid
    LIMIT 1
  `;
  return rows[0];
}

function parseClientId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return isValidClientUuid(id) ? id : null;
}

function parseFormData(body: unknown): ConsentFormData | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as { form_data?: unknown };
  const data = record.form_data;
  if (data === undefined || data === null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) return null;
  return data as ConsentFormData;
}

function parseSignature(body: unknown): string | null | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as { signature_image?: unknown }).signature_image;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const { clientId: raw } = await params;
  const clientId = parseClientId(raw);
  if (!clientId) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    const client = await loadClient(clientId);
    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    let intake: IntakeRow | undefined;
    try {
      intake = await loadIntake(clientId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('client_intake_forms')) {
        console.error('[api/consent] intake table missing — run create_client_intake_forms.sql');
        return NextResponse.json(
          { error: 'schema_not_ready', message: 'Intake table not migrated' },
          { status: 503 }
        );
      }
      throw err;
    }

    return NextResponse.json(buildResponse(client, intake));
  } catch (err) {
    console.error('[api/consent] GET failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const { clientId: raw } = await params;
  const clientId = parseClientId(raw);
  if (!clientId) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const formData = parseFormData(body);
  if (formData === null) {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const signature = parseSignature(body);
  if (signature === undefined) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    const client = await loadClient(clientId);
    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const existing = await loadIntake(clientId);
    if (
      existing?.submitted_at ||
      client.has_consented
    ) {
      return NextResponse.json(
        { error: 'already_submitted', message: 'This intake form has already been submitted.' },
        { status: 409 }
      );
    }

    const formDataJson = JSON.stringify(formData);

    await sql`
      INSERT INTO client_intake_forms (client_id, form_data, signature_image, submitted_at)
      VALUES (
        ${clientId}::uuid,
        ${formDataJson}::jsonb,
        ${signature},
        NOW()
      )
    `;

    if (!signature) {
      return NextResponse.json(
        { error: 'missing_signature', message: 'A signature is required.' },
        { status: 400 }
      );
    }

    let stampedPdfUrl: string;
    try {
      stampedPdfUrl = await stampConsentPDF(clientId, formData, signature);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/consent] PDF stamp failed:', message);
      if (message.includes('No consent PDF template')) {
        return NextResponse.json(
          { error: 'template_not_configured', message },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: 'pdf_stamp_failed', message },
        { status: 502 }
      );
    }

    await sql`
      UPDATE client_intake_forms
      SET stamped_pdf_url = ${stampedPdfUrl}
      WHERE client_id = ${clientId}::uuid
    `;

    await sql`
      UPDATE clients
      SET
        has_consented = true,
        consent_form_url = ${stampedPdfUrl}
      WHERE id = ${clientId}::uuid
    `;

    const intake = await loadIntake(clientId);
    const updatedClient = (await loadClient(clientId))!;

    return NextResponse.json({
      ok: true,
      message: 'Intake form submitted successfully.',
      ...buildResponse(updatedClient, intake),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('client_intake_forms')) {
      return NextResponse.json(
        { error: 'schema_not_ready', message: 'Intake table not migrated' },
        { status: 503 }
      );
    }
    console.error('[api/consent] POST failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
