'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  EmailTemplateCardWire,
  EmailTemplateKey,
} from '@/lib/email-message-templates';

interface ListResponse {
  templates: EmailTemplateCardWire[];
}

interface SaveResponse {
  key: EmailTemplateKey;
  body: string;
  isCustom: boolean;
  defaultBody: string;
  preview: string;
  error?: string;
  message?: string;
}

function insertToken(
  body: string,
  token: string,
  selectionStart: number,
  selectionEnd: number
) {
  const chip = `{{${token}}}`;
  return {
    next: body.slice(0, selectionStart) + chip + body.slice(selectionEnd),
    caret: selectionStart + chip.length,
  };
}

function ScenarioCard({
  card,
  onSaved,
}: {
  card: EmailTemplateCardWire;
  onSaved: (next: EmailTemplateCardWire) => void;
}) {
  const [body, setBody] = useState(card.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(
    null
  );

  useEffect(() => {
    setBody(card.body);
    setError(null);
  }, [card.key, card.body]);

  const dirty = body.trim() !== card.body.trim();

  const livePreview = useMemo(() => {
    if (!dirty) return card.preview;
    return body.trim();
  }, [dirty, body, card.preview]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/email-messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: card.key, body }),
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok) {
        setError(data.message || data.error || 'Save failed');
        return;
      }
      onSaved({
        ...card,
        body: data.body,
        isCustom: data.isCustom,
        preview: data.preview,
        defaultBody: data.defaultBody,
      });
      setBody(data.body);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/email-messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: card.key, reset: true }),
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok) {
        setError(data.message || data.error || 'Reset failed');
        return;
      }
      onSaved({
        ...card,
        body: data.body,
        isCustom: false,
        preview: data.preview,
        defaultBody: data.defaultBody,
      });
      setBody(data.body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onInsert = (token: string) => {
    const el = textareaEl;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const { next, caret } = insertToken(body, token, start, end);
    setBody(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <article className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="grid gap-0 md:grid-cols-2">
        <section className="border-b border-stone-200 p-5 md:border-b-0 md:border-r">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-serif text-xl text-stone-900">{card.title}</h2>
            {card.isCustom ? (
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-600">
                Custom
              </span>
            ) : (
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500">
                Default
              </span>
            )}
          </div>
          <p className="mt-3 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            When this sends
          </p>
          <ul className="mt-2 space-y-2 text-sm leading-relaxed text-stone-600">
            {card.triggers.map((trigger) => (
              <li key={trigger} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
                <span>{trigger}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="p-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            Editable paragraph
          </p>
          <p className="mt-2 text-xs leading-relaxed text-stone-500">
            Layout, greeting, button, and footer stay locked. Only this body
            copy is editable.
          </p>

          <textarea
            ref={setTextareaEl}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            spellCheck
            className="mt-3 w-full resize-y rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-stone-900 outline-none focus:ring-2 focus:ring-stone-900/15"
            aria-label={`${card.title} email body`}
          />

          {card.allowedPlaceholders.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {card.allowedPlaceholders.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => onInsert(token)}
                  className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
                >
                  {`{{${token}}}`}
                </button>
              ))}
            </div>
          ) : null}

          {card.requiredPlaceholders.length > 0 ? (
            <p className="mt-2 text-[11px] text-stone-500">
              Required:{' '}
              {card.requiredPlaceholders.map((t) => `{{${t}}}`).join(', ')}
            </p>
          ) : null}

          <div className="mt-4">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
              Preview
            </p>
            <div className="mt-2 rounded-md border border-dashed border-stone-300 bg-[#FAF9F6] px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-stone-800">
              {livePreview}
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-sm text-rose-700" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-md bg-stone-900 px-3.5 py-2 text-xs font-semibold uppercase tracking-wider text-[#FAF9F6] transition enabled:hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => void resetDefault()}
              disabled={saving}
              className="rounded-md border border-stone-200 bg-white px-3.5 py-2 text-xs font-semibold uppercase tracking-wider text-stone-700 transition hover:bg-stone-50 disabled:opacity-40"
            >
              Reset to default
            </button>
            {savedFlash ? (
              <span className="text-xs font-medium text-emerald-700">Saved</span>
            ) : null}
          </div>
        </section>
      </div>
    </article>
  );
}

export default function EmailMessagesClient() {
  const [templates, setTemplates] = useState<EmailTemplateCardWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/email-messages', { cache: 'no-store' });
      const data = (await res.json()) as ListResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setLoadError(data.message || data.error || 'Failed to load templates');
        return;
      }
      setTemplates(data.templates || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = (next: EmailTemplateCardWire) => {
    setTemplates((prev) =>
      prev.map((card) => (card.key === next.key ? next : card))
    );
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white px-5 py-8 text-sm text-stone-500">
        Loading email scenarios…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
        <p>{loadError}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 text-xs font-semibold uppercase tracking-wider underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {templates.map((card) => (
        <ScenarioCard key={card.key} card={card} onSaved={onSaved} />
      ))}
    </div>
  );
}
