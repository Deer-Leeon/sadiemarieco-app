'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { formatPhone } from '@/app/admin/helpers';

export type ManualSmsKind = 'consent_request' | 'review_request';

interface Props {
  open: boolean;
  kind: ManualSmsKind;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  onClose: () => void;
  onSent?: (kind: ManualSmsKind) => void;
}

function phoneLabel(raw: string | null): string {
  if (!raw) return 'Unknown number';
  const digits = raw.replace(/\D/g, '');
  return formatPhone(digits, raw);
}

function copyForKind(kind: ManualSmsKind): { title: string; body: string } {
  if (kind === 'consent_request') {
    return {
      title: 'Send consent text?',
      body: 'They will get the consent form link by text, with the usual rates and STOP / HELP footer.',
    };
  }
  return {
    title: 'Send review text?',
    body: 'They will get the Google review request by text, with the usual rates and STOP / HELP footer. “Ask after next visit” will turn off so a scheduled send does not go out too.',
  };
}

export default function ClientSendSmsConfirmModal({
  open,
  kind,
  clientId,
  clientName,
  clientPhone,
  onClose,
  onSent,
}: Props) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (!sending) onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, sending, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const copy = copyForKind(kind);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/sms-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      setSent(true);
      onSent?.(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-110 flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!sending) onClose();
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-200/80 bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-send-sms-title"
      >
        <div className="flex items-start justify-between gap-3 border-b border-stone-200/70 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
              Send text
            </p>
            <h2
              id="client-send-sms-title"
              className="font-serif text-xl text-stone-900"
            >
              {copy.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="text-sm text-stone-800">
            {clientName || 'This client'}
            <span className="mt-0.5 block text-xs text-stone-500">
              {phoneLabel(clientPhone)}
            </span>
          </p>
          <p className="text-sm leading-relaxed text-stone-600">{copy.body}</p>
          {error ? (
            <p className="text-sm text-rose-700" role="alert">
              {error}
            </p>
          ) : null}
          {sent ? (
            <p className="text-sm text-emerald-800" role="status">
              Text sent.
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-200/70 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-full border border-stone-200 bg-white px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            {sent ? 'Done' : 'Cancel'}
          </button>
          {!sent ? (
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-900 bg-stone-900 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-white transition-colors hover:bg-stone-800 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : null}
              {sending ? 'Sending…' : 'Send text'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
