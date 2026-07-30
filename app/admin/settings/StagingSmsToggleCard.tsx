'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Staging-only card: turn real Twilio SMS on/off for this deployment.
 * Production never renders this component.
 */
export default function StagingSmsToggleCard() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [enabled, setEnabled] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/settings/staging-sms', {
        cache: 'no-store',
      });
      const data = (await res.json()) as {
        enabled?: boolean;
        message?: string;
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        setFetchError(
          data.hint || data.message || data.error || 'Could not load SMS setting.'
        );
        setLoadState('error');
        return;
      }
      setEnabled(data.enabled === true);
      setLoadState('ready');
    } catch {
      setFetchError('Could not load SMS setting.');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    const next = !enabled;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/admin/settings/staging-sms', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = (await res.json()) as {
        enabled?: boolean;
        message?: string;
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        setSaveError(
          data.hint || data.message || data.error || 'Could not save.'
        );
        return;
      }
      setEnabled(data.enabled === true);
    } catch {
      setSaveError('Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-amber-200/80 bg-amber-50/40 p-6 shadow-sm shadow-stone-900/3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-800/80">
            Staging only
          </p>
          <h2 className="font-serif text-xl text-stone-900">Outbound SMS</h2>
          <p className="text-sm leading-relaxed text-stone-600">
            When on, confirmation / reminder / feedback texts send through the
            real Twilio number (~1¢ each). Off by default. Sunday DB resets
            turn this back off.
          </p>
        </div>

        {loadState === 'loading' ? (
          <Loader2 className="mt-1 h-5 w-5 shrink-0 animate-spin text-stone-400" />
        ) : loadState === 'ready' ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Outbound SMS on staging"
            disabled={saving}
            onClick={() => void toggle()}
            className={[
              'relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/20',
              'disabled:opacity-60',
              enabled ? 'bg-stone-900' : 'bg-stone-300',
            ].join(' ')}
          >
            <span
              className={[
                'absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform',
                enabled ? 'translate-x-5' : 'translate-x-0',
              ].join(' ')}
            />
          </button>
        ) : null}
      </div>

      {loadState === 'ready' ? (
        <p className="mt-4 text-xs font-medium tracking-wide text-stone-500">
          Currently:{' '}
          <span className={enabled ? 'text-emerald-800' : 'text-stone-700'}>
            {enabled ? 'SMS enabled' : 'SMS disabled'}
          </span>
          {saving ? ' · saving…' : null}
        </p>
      ) : null}

      {fetchError ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {fetchError}
        </p>
      ) : null}
      {saveError ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {saveError}
        </p>
      ) : null}
    </section>
  );
}
