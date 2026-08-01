/**
 * GET  /api/admin/email-messages — list editable email body templates
 * PATCH /api/admin/email-messages — save one body `{ key, body }`
 *   Pass `body: null` (or reset: true) to revert to the default.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_META,
  SAMPLE_EMAIL_PREVIEW_VARS,
  listEmailTemplateCards,
  renderEmailTemplate,
  upsertEmailTemplate,
  validateEmailBody,
  type EmailTemplateKey,
} from '@/lib/email-message-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function isEmailTemplateKey(value: unknown): value is EmailTemplateKey {
  return (
    typeof value === 'string' &&
    (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value)
  );
}

export async function GET(): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  try {
    const templates = await listEmailTemplateCards();
    return NextResponse.json({ templates });
  } catch (err) {
    console.error('[api/admin/email-messages] GET failed', err);
    return NextResponse.json(
      {
        error: 'load_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  if (!isEmailTemplateKey(record.key)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
  }

  const reset = record.reset === true;
  const bodyRaw = record.body;

  try {
    if (reset || bodyRaw === null) {
      const saved = await upsertEmailTemplate(record.key, null);
      const meta = EMAIL_TEMPLATE_META[record.key];
      return NextResponse.json({
        key: saved.key,
        body: saved.body,
        isCustom: saved.isCustom,
        defaultBody: meta.defaultBody,
        preview: renderEmailTemplate(saved.body, SAMPLE_EMAIL_PREVIEW_VARS),
      });
    }

    if (typeof bodyRaw !== 'string') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }

    const validated = validateEmailBody(record.key, bodyRaw);
    if (!validated.ok) {
      return NextResponse.json(
        { error: 'validation_failed', message: validated.error },
        { status: 400 }
      );
    }

    const saved = await upsertEmailTemplate(record.key, validated.body);
    const meta = EMAIL_TEMPLATE_META[record.key];
    return NextResponse.json({
      key: saved.key,
      body: saved.body,
      isCustom: saved.isCustom,
      defaultBody: meta.defaultBody,
      preview: renderEmailTemplate(saved.body, SAMPLE_EMAIL_PREVIEW_VARS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'validation'
    ) {
      return NextResponse.json(
        { error: 'validation_failed', message },
        { status: 400 }
      );
    }
    console.error('[api/admin/email-messages] PATCH failed', err);
    return NextResponse.json(
      { error: 'save_failed', message },
      { status: 500 }
    );
  }
}
