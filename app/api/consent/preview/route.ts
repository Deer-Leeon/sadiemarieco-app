/**
 * POST /api/consent/preview
 *
 * Returns a temporary Base64 PDF preview filled from form_data.
 * Does not write to the database or Vercel Blob.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  asConsentFormData,
  validateConsentForm,
} from '@/app/consent/[clientId]/consent-form-config';
import { generateUnsignedPreviewPDF } from '@/lib/pdf-stamper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const raw = (body as { form_data?: unknown }).form_data;
  if (raw === undefined || raw === null) {
    return NextResponse.json({ error: 'missing_form_data' }, { status: 400 });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const formData = asConsentFormData(raw);
  const validationError = validateConsentForm(formData);
  if (validationError) {
    return NextResponse.json(
      { error: 'validation_failed', message: validationError },
      { status: 400 }
    );
  }

  try {
    const pdfBase64 = await generateUnsignedPreviewPDF(formData);
    return NextResponse.json({ pdf_base64: pdfBase64 });
  } catch (err) {
    const message = errorMessage(err);
    console.error('[api/consent/preview] failed:', message);
    if (message.includes('No consent PDF template')) {
      return NextResponse.json(
        { error: 'template_not_configured', message },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'preview_failed', message },
      { status: 502 }
    );
  }
}
