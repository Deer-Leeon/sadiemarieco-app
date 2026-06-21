'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HealthCheckResult, HealthReport, HealthStatus } from '@/lib/health-check';

const STATUS_ORDER: HealthStatus[] = ['unhealthy', 'degraded', 'healthy', 'skipped'];

const STATUS_META: Record<
  HealthStatus,
  { label: string; dot: string; badge: string; ring: string }
> = {
  healthy: {
    label: 'Healthy',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    ring: 'ring-emerald-200',
  },
  degraded: {
    label: 'Degraded',
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-900 border-amber-200',
    ring: 'ring-amber-200',
  },
  unhealthy: {
    label: 'Unhealthy',
    dot: 'bg-rose-500',
    badge: 'bg-rose-50 text-rose-900 border-rose-200',
    ring: 'ring-rose-200',
  },
  skipped: {
    label: 'Skipped',
    dot: 'bg-stone-300',
    badge: 'bg-stone-100 text-stone-600 border-stone-200',
    ring: 'ring-stone-200',
  },
};

const OVERALL_META: Record<HealthStatus, { title: string; panel: string }> = {
  healthy: {
    title: 'All systems operational',
    panel: 'border-emerald-200 bg-emerald-50/80',
  },
  degraded: {
    title: 'Some checks need attention',
    panel: 'border-amber-200 bg-amber-50/80',
  },
  unhealthy: {
    title: 'Critical issues detected',
    panel: 'border-rose-200 bg-rose-50/80',
  },
  skipped: {
    title: 'Health check complete',
    panel: 'border-stone-200 bg-stone-50',
  },
};

function formatCheckedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function groupByCategory(checks: HealthCheckResult[]): Map<string, HealthCheckResult[]> {
  const map = new Map<string, HealthCheckResult[]>();
  for (const check of checks) {
    const list = map.get(check.category) ?? [];
    list.push(check);
    map.set(check.category, list);
  }
  return map;
}

function CheckRow({ check }: { check: HealthCheckResult }) {
  const meta = STATUS_META[check.status];
  return (
    <div
      className={`rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-sm transition-shadow hover:shadow-md ${meta.ring} ring-1 ring-transparent`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-stone-900">{check.name}</h3>
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.badge}`}
            >
              {meta.label}
            </span>
            {check.latencyMs != null && (
              <span className="text-[11px] text-stone-400">{check.latencyMs}ms</span>
            )}
          </div>
          <p className="mt-1 text-sm text-stone-600">{check.message}</p>
          {check.detail && (
            <p className="mt-2 break-words rounded-md bg-stone-50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-stone-500">
              {check.detail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HealthCheckClient() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/health', { cache: 'no-store' });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          payload &&
          typeof payload === 'object' &&
          'message' in payload &&
          typeof (payload as { message: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : `Health check failed (HTTP ${res.status})`;
        throw new Error(message);
      }
      setReport(payload as HealthReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(
    () => (report ? groupByCategory(report.checks) : new Map()),
    [report]
  );

  const overallMeta = report ? OVERALL_META[report.overall] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-stone-500">
          Live probes for every dependency in the booking chain — database, Cal.com,
          email, SMS, payments, webhooks, cron jobs, and more. Run after deploys or
          when something feels off.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-800 shadow-sm transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Running…' : 'Run checks'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      {report && overallMeta && (
        <section
          className={`rounded-xl border px-5 py-4 ${overallMeta.panel}`}
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
                Overall status
              </p>
              <h2 className="mt-1 text-lg font-medium text-stone-900">
                {overallMeta.title}
              </h2>
              <p className="mt-1 text-xs text-stone-500">
                Last checked {formatCheckedAt(report.checkedAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {STATUS_ORDER.map((status) => {
                const count = report.summary[status];
                if (count === 0) return null;
                const meta = STATUS_META[status];
                return (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${meta.badge}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    {count} {meta.label.toLowerCase()}
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {loading && !report && (
        <div className="rounded-xl border border-stone-200 bg-white px-6 py-12 text-center text-sm text-stone-500">
          Running health checks…
        </div>
      )}

      {report &&
        [...grouped.entries()].map(([category, checks]) => (
          <section key={category} className="space-y-3">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.28em] text-stone-500">
              {category}
            </h2>
            <div className="space-y-2">
              {([...checks] as HealthCheckResult[])
                .sort(
                  (a: HealthCheckResult, b: HealthCheckResult) =>
                    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
                )
                .map((check: HealthCheckResult) => (
                  <CheckRow key={check.id} check={check} />
                ))}
            </div>
          </section>
        ))}
    </div>
  );
}
