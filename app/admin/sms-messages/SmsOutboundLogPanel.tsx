'use client';

import { useCallback, useState } from 'react';

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
  messages: LogMessage[];
  nextBefore: string | null;
  error?: string;
  message?: string;
}

function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

export default function SmsOutboundLogPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchPage = useCallback(async (before: string | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);
      const res = await fetch(
        `/api/admin/sms-messages/log${params.size ? `?${params}` : ''}`,
        { cache: 'no-store' }
      );
      const data = (await res.json()) as LogResponse;
      if (!res.ok) {
        setError(data.message || data.error || 'Failed to load sent texts');
        return;
      }
      setMessages((prev) =>
        append ? [...prev, ...(data.messages || [])] : data.messages || []
      );
      setNextBefore(data.nextBefore);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) {
      void fetchPage(null, false);
    }
  };

  return (
    <section className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-stone-50/80"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-medium uppercase tracking-[0.22em] text-stone-400">
            Sent log
          </span>
          <span className="mt-1 block font-serif text-xl text-stone-900">
            Texts that went out
          </span>
          <span className="mt-1 block text-sm text-stone-600">
            Every customer text, with the exact wording that went out.
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
          {open ? 'Hide' : 'View'}
          <span
            aria-hidden="true"
            className={`inline-block text-stone-400 transition-transform duration-200 ${
              open ? 'rotate-90' : ''
            }`}
          >
            ›
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-stone-200 px-5 py-4">
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => void fetchPage(null, false)}
                className="mt-2 text-xs font-semibold uppercase tracking-wider underline"
              >
                Retry
              </button>
            </div>
          ) : null}

          {!error && loading && !loaded ? (
            <p className="text-sm text-stone-500">Loading sent texts…</p>
          ) : null}

          {!error && loaded && messages.length === 0 ? (
            <p className="text-sm leading-relaxed text-stone-600">
              No texts logged yet. New sends from this point on will appear
              here.
            </p>
          ) : null}

          {messages.length > 0 ? (
            <ol className="space-y-4">
              {messages.map((row) => (
                <li
                  key={row.id}
                  className="border-b border-stone-100 pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-sm font-medium text-stone-900">
                      {row.clientName || 'Unknown client'}
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
                    {row.title}
                    <span className="ml-2 font-sans tracking-normal text-stone-400">
                      {formatPhone(row.to)}
                    </span>
                  </p>
                  <p className="mt-2 whitespace-pre-wrap rounded-md border border-stone-200 bg-[#FAF9F6] px-3 py-2.5 text-sm leading-relaxed text-stone-800">
                    {row.body}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}

          {nextBefore ? (
            <button
              type="button"
              onClick={() => void fetchPage(nextBefore, true)}
              disabled={loading}
              className="mt-4 text-xs font-semibold uppercase tracking-wider text-stone-700 underline decoration-stone-300 underline-offset-4 disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Load older'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
