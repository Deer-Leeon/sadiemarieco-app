/**
 * GET  /api/admin/sms-messages — list all editable SMS scenario templates
 * PATCH /api/admin/sms-messages — save one template body `{ key, body }`
 *   Pass `body: null` (or omit with reset: true) to revert to the default.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import {
  COMPLIANCE_TAIL,
  SMS_PREFIX,
  SMS_TEMPLATE_KEYS,
  SMS_TEMPLATE_META,
  SAMPLE_PREVIEW_VARS,
  listSmsTemplateCards,
  renderSmsTemplate,
  upsertSmsTemplate,
  validateSmsBody,
  type SmsTemplateKey,
} from '@/lib/sms-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function isSmsTemplateKey(value: unknown): value is SmsTemplateKey {
  return (
    typeof value === 'string' &&
    (SMS_TEMPLATE_KEYS as readonly string[]).includes(value)
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
    const templates = await listSmsTemplateCards();
    return NextResponse.json({
      templates,
      prefix: SMS_PREFIX,
      footer: COMPLIANCE_TAIL,
    });
  } catch (err) {
    console.error('[api/admin/sms-messages] GET failed', err);
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
  if (!isSmsTemplateKey(record.key)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
  }

  const reset = record.reset === true;
  const bodyRaw = record.body;

  try {
    if (reset || bodyRaw === null) {
      const saved = await upsertSmsTemplate(record.key, null);
      const meta = SMS_TEMPLATE_META[record.key];
      return NextResponse.json({
        key: saved.key,
        body: saved.body,
        isCustom: saved.isCustom,
        defaultBody: meta.defaultBody,
        preview: renderSmsTemplate(saved.body, SAMPLE_PREVIEW_VARS),
        prefix: SMS_PREFIX,
        footer: COMPLIANCE_TAIL,
      });
    }

    if (typeof bodyRaw !== 'string') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }

    const validated = validateSmsBody(record.key, bodyRaw);
    if (!validated.ok) {
      return NextResponse.json(
        { error: 'validation_failed', message: validated.error },
        { status: 400 }
      );
    }

    const saved = await upsertSmsTemplate(record.key, validated.body);
    const meta = SMS_TEMPLATE_META[record.key];
    return NextResponse.json({
      key: saved.key,
      body: saved.body,
      isCustom: saved.isCustom,
      defaultBody: meta.defaultBody,
      preview: renderSmsTemplate(saved.body, SAMPLE_PREVIEW_VARS),
      prefix: SMS_PREFIX,
      footer: COMPLIANCE_TAIL,
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
    console.error('[api/admin/sms-messages] PATCH failed', err);
    return NextResponse.json(
      { error: 'save_failed', message },
      { status: 500 }
    );
  }
}
