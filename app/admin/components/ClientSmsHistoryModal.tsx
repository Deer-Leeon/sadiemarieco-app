'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { formatPhone } from '@/app/admin/helpers';
import { formatStudioClock, formatStudioDateShort } from '@/lib/studio-calendar';

interface LogMessage {
  id: string;
  createdAt: string;
  templateKey: string;
  title: string;
  body: string;
  to: string;
  clientId: string | null;
  clientName: string | null;
  bookingUid: string | null;
}

interface LogResponse {
  phone: string | null;
  messages: LogMessage[];
  nextBefore: string | null;
  twilioSync?: {
    imported: number;
    scanned: number;
    skipped: boolean;
    reason?: string;
    error?: string;
  } | null;
  error?: string;
  message?: string;
}

interface Props {
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  open: boolean;
  onClose: () => void;
}

function phoneLabel(raw: string | null | undefined): string {
  if (!raw) return 'Unknown number';
  const digits = raw.replace(/\D/g, '');
  return formatPhone(digits, raw);
}

export default function ClientSmsHistoryModal({
  clientId,
  clientName,
  clientPhone,
  open,
  onClose,
}: Props) {
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(clientPhone);
  const [imported, setImported] = useState(0);
  const [twilioNote, setTwilioNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchPage = useCallback(
    async (before: string | null, append: boolean) => {
      if (before) setLoadingOlder(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        const res = await fetch(
          `/api/admin/clients/${clientId}/sms-messages${
            params.size ? `?${params}` : ''
          }`,
          { cache: 'no-store' }
        );
        const data = (await res.json()) as LogResponse;
        if (!res.ok) {
          setError(data.message || data.error || 'Failed to load texts');
          return;
        }
        setPhone(data.phone ?? clientPhone);
        setMessages((prev) =>
          append ? [...prev, ...(data.messages || [])] : data.messages || []
        );
        setNextBefore(data.nextBefore);
        setLoaded(true);
        if (!append && data.twilioSync) {
          setImported(data.twilioSync.imported);
          if (data.twilioSync.error) {
            setTwilioNote(
              'Could not reach Twilio for older texts. Showing what is already saved.'
            );
          } else if (data.twilioSync.reason === 'missing_twilio_env') {
            setTwilioNote(null);
          } else {
            setTwilioNote(null);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingOlder(false);
      }
    },
    [clientId, clientPhone]
  );

  useEffect(() => {
    if (!open) return;
    setMessages([]);
    setNextBefore(null);
    setImported(0);
    setTwilioNote(null);
    setLoaded(false);
    void fetchPage(null, false);
  }, [open, fetchPage]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-[#FAF9F6] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-sms-history-title"
      >
        <div className="flex items-start justify-between gap-3 border-b border-stone-200/70 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-stone-500">
              Text history
            </p>
            <h2
              id="client-sms-history-title"
              className="font-serif text-xl text-stone-900"
            >
              {clientName || 'Client'}
            </h2>
            <p className="mt-1 text-sm text-stone-600">
              Sent to {phoneLabel(phone)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close text history"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading texts, including older ones from Twilio…
            </div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-sm text-rose-700">{error}</p>
              <button
                type="button"
                onClick={() => void fetchPage(null, false)}
                className="mt-3 text-xs font-semibold uppercase tracking-wider text-stone-700 underline decoration-stone-300 underline-offset-4"
              >
                Retry
              </button>
            </div>
          ) : !loaded || messages.length === 0 ? (
            <p className="py-8 text-center text-sm leading-relaxed text-stone-500">
              No texts found for this client. New sends will show up here.
            </p>
          ) : (
            <>
              {imported > 0 ? (
                <p className="mb-3 text-xs text-stone-500">
                  Pulled {imported} older{' '}
                  {imported === 1 ? 'text' : 'texts'} from Twilio into this
                  history.
                </p>
              ) : null}
              {twilioNote ? (
                <p className="mb-3 text-xs text-amber-800">{twilioNote}</p>
              ) : null}
              <ol className="space-y-4">
                {messages.map((row) => (
                  <li
                    key={row.id}
                    className="border-b border-stone-100 pb-4 last:border-b-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="text-sm font-medium text-stone-900">
                        {row.title}
                      </p>
                      <time
                        dateTime={row.createdAt}
                        className="text-[11px] tabular-nums text-stone-500"
                      >
                        {formatStudioDateShort(row.createdAt)},{' '}
                        {formatStudioClock(row.createdAt)}
                      </time>
                    </div>
                    <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400">
                      {phoneLabel(row.to)}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-stone-800">
                      {row.body}
                    </p>
                  </li>
                ))}
              </ol>
              {nextBefore ? (
                <button
                  type="button"
                  onClick={() => void fetchPage(nextBefore, true)}
                  disabled={loadingOlder}
                  className="mt-4 text-xs font-semibold uppercase tracking-wider text-stone-700 underline decoration-stone-300 underline-offset-4 disabled:opacity-40"
                >
                  {loadingOlder ? 'Loading…' : 'Load older'}
                </button>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t border-stone-200/70 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-full border border-stone-200 bg-white py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-stone-800 transition-colors hover:bg-stone-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
