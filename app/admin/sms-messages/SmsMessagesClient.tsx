'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SmsTemplateCardWire, SmsTemplateKey } from '@/lib/sms-templates';

interface ListResponse {
  templates: SmsTemplateCardWire[];
  prefix: string;
  footer: string;
}

interface SaveResponse {
  key: SmsTemplateKey;
  body: string;
  isCustom: boolean;
  defaultBody: string;
  preview: string;
  prefix: string;
  footer: string;
  error?: string;
  message?: string;
}

function insertToken(body: string, token: string, selectionStart: number, selectionEnd: number) {
  const chip = `{{${token}}}`;
  return {
    next: body.slice(0, selectionStart) + chip + body.slice(selectionEnd),
    caret: selectionStart + chip.length,
  };
}

function ScenarioCard({
  card,
  prefix,
  footer,
  onSaved,
}: {
  card: SmsTemplateCardWire;
  prefix: string;
  footer: string;
  onSaved: (next: SmsTemplateCardWire) => void;
}) {
  const [body, setBody] = useState(card.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setBody(card.body);
    setError(null);
  }, [card.key, card.body]);

  const dirty = body.trim() !== card.body.trim();

  const livePreview = useMemo(() => {
    // Client-side approximate preview: mirror server chrome; tokens stay
    // literal until save refreshes the sample-filled preview from the API.
    // Prefer API preview when not dirty.
    if (!dirty) return card.preview;
    return `${prefix}${body.trim()} ${footer}`.replace(/[ \t]{2,}/g, ' ').trim();
  }, [dirty, body, prefix, footer, card.preview]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sms-messages', {
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
        sendingLive: card.sendingLive,
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
      const res = await fetch('/api/admin/sms-messages', {
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
        sendingLive: card.sendingLive,
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
            <h2 className="font-serif text-xl text-stone-900">
              {card.title}
            </h2>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {!card.sendingLive ? (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800">
                  Not connected
                </span>
              ) : null}
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
          </div>
          {!card.sendingLive ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs leading-relaxed text-amber-950">
              Placeholder only — edit and save your preferred copy here. This
              message is <span className="font-semibold">not sent yet</span>{' '}
              until send logic is connected.
            </p>
          ) : null}
          <p className="mt-3 text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            {card.sendingLive ? 'When this sends' : 'Intended trigger'}
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
            Message
          </p>

          <div className="mt-3 rounded-md border border-stone-200 bg-stone-50/80">
            <div className="border-b border-stone-200 px-3 py-2 text-xs text-stone-500">
              {prefix}
              <span className="ml-1 text-stone-400">(locked)</span>
            </div>
            <textarea
              ref={setTextareaEl}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              spellCheck
              className="w-full resize-y bg-white px-3 py-2.5 text-sm leading-relaxed text-stone-900 outline-none focus:ring-2 focus:ring-inset focus:ring-stone-900/15"
              aria-label={`${card.title} message body`}
            />
            <div className="border-t border-stone-200 px-3 py-2 text-xs text-stone-500">
              {footer}
              <span className="ml-1 text-stone-400">(locked)</span>
            </div>
          </div>

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
            <div className="mt-2 rounded-md border border-dashed border-stone-300 bg-[#FAF9F6] px-3 py-2.5 text-sm leading-relaxed text-stone-800">
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

export default function SmsMessagesClient() {
  const [templates, setTemplates] = useState<SmsTemplateCardWire[]>([]);
  const [prefix, setPrefix] = useState('Sadie Marie: ');
  const [footer, setFooter] = useState(
    'Msg & data rates may apply. Reply STOP to opt out, HELP for help.'
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/sms-messages', { cache: 'no-store' });
      const data = (await res.json()) as ListResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setLoadError(data.message || data.error || 'Failed to load templates');
        return;
      }
      setTemplates(data.templates || []);
      if (data.prefix) setPrefix(data.prefix);
      if (data.footer) setFooter(data.footer);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = (next: SmsTemplateCardWire) => {
    setTemplates((prev) =>
      prev.map((card) => (card.key === next.key ? next : card))
    );
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white px-5 py-8 text-sm text-stone-500">
        Loading SMS scenarios…
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
    <div className="space-y-8">
      <section className="space-y-5">
        <div>
          <h2 className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            Live — sending today
          </h2>
          <p className="mt-1 text-sm text-stone-600">
            These messages are wired to Twilio. Edits apply to the next send.
          </p>
        </div>
        {templates
          .filter((card) => card.sendingLive)
          .map((card) => (
            <ScenarioCard
              key={card.key}
              card={card}
              prefix={prefix}
              footer={footer}
              onSaved={onSaved}
            />
          ))}
      </section>

      <section className="space-y-5">
        <div>
          <h2 className="text-[10px] font-medium uppercase tracking-[0.22em] text-amber-700/80">
            Placeholders — not connected yet
          </h2>
          <p className="mt-1 text-sm text-stone-600">
            Draft copy only. Nothing is sent for these scenarios until you ask
            to wire them up.
          </p>
        </div>
        {templates
          .filter((card) => !card.sendingLive)
          .map((card) => (
            <ScenarioCard
              key={card.key}
              card={card}
              prefix={prefix}
              footer={footer}
              onSaved={onSaved}
            />
          ))}
      </section>
    </div>
  );
}
