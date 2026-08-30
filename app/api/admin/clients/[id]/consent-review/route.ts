/**
 * POST /api/admin/clients/[id]/consent-review
 *
 * Rebuilds the signed consent PDF from intake + signature with the
 * printed "☐ Reviewed by Technician" box checked, overwrites the Blob,
 * and records `consent_technician_reviewed_at` on the clients row.
 *
 * Idempotent: safe to re-run when already reviewed (repairs a missing
 * checkmark by regenerating from the template).
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { EMPTY_CLIENT_CRM_STATS, type Client } from '@/app/admin/types';
import { reviewFlagsFromRow } from '@/lib/client-review-flags';
import { asConsentFormData } from '@/app/consent/[clientId]/consent-form-config';
import { parseOptionalClientEmail } from '@/lib/client-identity';
import { fetchClientCrmStats } from '@/lib/client-crm-stats';
import { stampTechnicianReviewOnConsentPdf } from '@/lib/pdf-stamper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  params: Promise<{ id: string }>;
}

interface ClientRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: string | null;
  has_consented: boolean;
  consent_form_url: string | null;
  consent_technician_reviewed_at: Date | string | null;
  no_show_count?: number | string | null;
  no_show_flag?: boolean | null;
  no_show_admin_count?: number | string | null;
  no_show_auto_cancel_count?: number | string | null;
  no_show_auto_reschedule_count?: number | string | null;
  late_change_count?: number | string | null;
  late_change_cancel_count?: number | string | null;
  late_change_reschedule_count?: number | string | null;
  no_show_waive_next?: boolean | null;
  late_change_waive_next?: boolean | null;
  review_request_pending?: boolean | null;
  google_review_noted?: boolean | null;
  google_review_noted_at?: Date | string | null;
  review_request_last_sent_at?: Date | string | null;
}

interface IntakeRow {
  form_data: unknown;
  signature_image: string | null;
  stamped_pdf_url: string | null;
  submitted_at: Date | string | null;
}

let columnEnsured = false;

async function ensureReviewedAtColumn(): Promise<void> {
  if (columnEnsured) return;
  await sql.query(`
    ALTER TABLE clients
      ADD COLUMN IF NOT EXISTS consent_technician_reviewed_at TIMESTAMPTZ
  `);
  columnEnsured = true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function rowToClient(row: ClientRow): Promise<Client> {
  const base: Client = {
    ...EMPTY_CLIENT_CRM_STATS,
    id: row.id,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    email: parseOptionalClientEmail(row.email),
    created_at: row.created_at,
    has_consented: Boolean(row.has_consented),
    consent_form_url: row.consent_form_url,
    consent_technician_reviewed_at: serializeDate(
      row.consent_technician_reviewed_at
    ),
    no_show_count: toNumber(row.no_show_count),
    no_show_flag: Boolean(row.no_show_flag),
    no_show_admin_count: toNumber(row.no_show_admin_count),
    no_show_auto_cancel_count: toNumber(row.no_show_auto_cancel_count),
    no_show_auto_reschedule_count: toNumber(row.no_show_auto_reschedule_count),
    late_change_count: toNumber(row.late_change_count),
    late_change_cancel_count: toNumber(row.late_change_cancel_count),
    late_change_reschedule_count: toNumber(row.late_change_reschedule_count),
    no_show_waive_next:
      row.no_show_waive_next === null || row.no_show_waive_next === undefined
        ? true
        : Boolean(row.no_show_waive_next),
    late_change_waive_next:
      row.late_change_waive_next === null ||
      row.late_change_waive_next === undefined
        ? true
        : Boolean(row.late_change_waive_next),
    ...reviewFlagsFromRow(row),
  };

  try {
    const stats = await fetchClientCrmStats(row.id, {
      email: row.email,
      phone: row.phone,
    });
    return { ...base, ...stats, ...reviewFlagsFromRow(row) };
  } catch (err) {
    console.warn(
      '[api/admin/clients/consent-review] fetchClientCrmStats failed',
      errorMessage(err)
    );
    return base;
  }
}

async function loadClient(id: string): Promise<ClientRow | null> {
  const { rows } = await sql<ClientRow>`
    SELECT
      id,
      phone,
      first_name,
      last_name,
      email,
      created_at,
      has_consented,
      consent_form_url,
      consent_technician_reviewed_at,
      no_show_count,
      no_show_flag,
      no_show_admin_count,
      no_show_auto_cancel_count,
      no_show_auto_reschedule_count,
      late_change_count,
      late_change_cancel_count,
      late_change_reschedule_count,
      no_show_waive_next,
      late_change_waive_next,
      review_request_pending,
      google_review_noted,
      google_review_noted_at,
      review_request_last_sent_at
    FROM clients
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function POST(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const { id: raw } = await params;
  const id = raw.trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    await ensureReviewedAtColumn();

    const client = await loadClient(id);
    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (!client.has_consented) {
      return NextResponse.json(
        {
          error: 'consent_not_signed',
          message: 'Client must finish and sign the consent form first.',
        },
        { status: 409 }
      );
    }

    const alreadyReviewed = Boolean(client.consent_technician_reviewed_at);

    const { rows: intakeRows } = await sql<IntakeRow>`
      SELECT form_data, signature_image, stamped_pdf_url, submitted_at
      FROM client_intake_forms
      WHERE client_id = ${id}::uuid
      LIMIT 1
    `;
    const intake = intakeRows[0];
    const signature = intake?.signature_image?.trim() ?? '';
    if (!intake?.submitted_at || !signature) {
      return NextResponse.json(
        {
          error: 'consent_pdf_missing',
          message:
            'No signed consent intake is on file for this client yet (missing signature).',
        },
        { status: 409 }
      );
    }

    const formData = asConsentFormData(intake.form_data);
    const stampedPdfUrl = await stampTechnicianReviewOnConsentPdf(
      id,
      formData,
      signature
    );
    // Always refresh the timestamp so PDF links cache-bust after re-stamp.
    const reviewedAt = new Date().toISOString();

    await sql`
      UPDATE clients
      SET
        consent_form_url = ${stampedPdfUrl},
        consent_technician_reviewed_at = ${reviewedAt}::timestamptz
      WHERE id = ${id}::uuid
    `;

    await sql`
      UPDATE client_intake_forms
      SET stamped_pdf_url = ${stampedPdfUrl}
      WHERE client_id = ${id}::uuid
    `;

    const refreshed = await loadClient(id);
    if (!refreshed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({
      client: await rowToClient(refreshed),
      already_reviewed: alreadyReviewed,
    });
  } catch (err) {
    console.error(
      '[api/admin/clients/consent-review] POST failed:',
      errorMessage(err)
    );
    return NextResponse.json(
      { error: 'review_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
