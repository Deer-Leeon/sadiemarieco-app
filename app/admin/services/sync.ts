/**
 * Shared Cal.com sync utilities used by every path that reads or
 * writes the local service catalogue:
 *
 *   • /api/admin/services        — CRUD route handler (POST/PATCH/DELETE
 *                                  call callCal; GET runs the reconciler)
 *   • /admin/services/page.tsx   — Server Component that paints the
 *                                  editor's initial list; reconciles
 *                                  before its DB SELECT so an orphan
 *                                  (service deleted directly in Cal.com)
 *                                  disappears from the UI on the same
 *                                  page load
 *   • /  (app/route.ts)          — Public homepage HTML renderer;
 *                                  reconciles before its SELECT too so
 *                                  the customer-facing menu drops the
 *                                  orphan within the TTL window
 *
 * Why this lives in its own module:
 *   The first version of this code lived inside the route handler.
 *   That worked for client-side refetches but left a hole — the
 *   Server Components don't traverse our own API; they query
 *   site_services directly. Refreshing /admin/services therefore
 *   never triggered reconciliation, and orphans stayed visible
 *   forever. Centralising the helper here so all three render paths
 *   can call it closes that hole.
 *
 * TTL caching:
 *   The public homepage is high-traffic and shouldn't fire a Cal
 *   round-trip per request. `reconcileWithCal()` caches the last
 *   successful reconcile timestamp at module scope and short-circuits
 *   if called again within RECONCILE_TTL_MS. Admin paths pass
 *   `{ force: true }` to bypass — the editor expects "I just did X
 *   in Cal, refresh shows it" to be immediate.
 *
 *   In-process cache only — each serverless instance has its own
 *   counter, so worst case is one extra Cal call per cold start. We
 *   never go LESS often than the TTL, which is the property that
 *   actually matters for rate limits and Cal API quota.
 */
import { sql } from '@vercel/postgres';

import {
  CAL_AFTER_EVENT_BUFFER_MIN,
  CAL_SLOT_INTERVAL_MIN,
} from '@/lib/cal-config';

const CAL_API_BASE = 'https://api.cal.com/v2';

// 2024-06-14 is the schema this code was written against
// (lengthInMinutes wire field, data.id response, GetEventTypesOutput).
// Pinning the version means a future Cal-side rev can't silently
// change shapes underneath us.
const CAL_API_VERSION = '2024-06-14';

/**
 * Public homepage TTL. 60 seconds is a deliberate trade-off between
 * "orphan vanishes promptly after a Cal-side delete" and "we don't
 * spam Cal's API on every visitor". The admin paths force-refresh
 * so the editor never waits on this.
 */
const RECONCILE_TTL_MS = 60_000;

// ─── CAL CLIENT ────────────────────────────────────────────────────────────

/**
 * Typed wrapper around Cal.com error responses. Carries the HTTP
 * status as a first-class field so individual handlers can branch on
 * specific statuses (404 = already deleted, swallow and keep going)
 * without parsing the message string. The .message is still the
 * human-readable Cal payload so logs and surfaced API errors keep
 * their context.
 */
export class CalApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`Cal.com ${status}: ${detail}`);
    this.name = 'CalApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Thin wrapper around fetch for Cal.com v2.
 *
 * Reasons for the indirection:
 *   • Centralises the v2 auth + version headers (Bearer token,
 *     `cal-api-version`) so individual call sites don't drift.
 *   • Surfaces Cal.com error bodies verbatim in the thrown
 *     CalApiError so the client gets actionable messages ("slug
 *     already exists", "invalid length", etc.) rather than a
 *     generic 502.
 *   • Returns parsed JSON when available, an empty object otherwise
 *     (Cal.com's PATCH/DELETE responses are sometimes 204 No Content).
 */
export async function callCal<T = unknown>(
  path: string,
  apiKey: string,
  init: RequestInit
): Promise<T> {
  const res = await fetch(`${CAL_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'cal-api-version': CAL_API_VERSION,
      ...(init.headers ?? {}),
    },
    // Cal.com responses shouldn't be cached by anything in the chain —
    // even a brief stale read could mislead the editor about whether
    // a write actually landed.
    cache: 'no-store',
  });

  const raw = await res.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!res.ok) {
    const detail = extractCalErrorMessage(parsed) || res.statusText;
    throw new CalApiError(res.status, detail);
  }

  return (parsed ?? {}) as T;
}

/**
 * Pull the most useful human-readable string out of a Cal.com error
 * response. v2 nests under `error.message`; v1 used top-level
 * `message`; plain-text bodies are returned verbatim. Falls back to
 * the JSON-stringified payload (truncated) so we never lose context.
 */
export function extractCalErrorMessage(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (!isRecord(parsed)) return '';
  const err = parsed.error;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  if (typeof parsed.message === 'string') return parsed.message;
  return JSON.stringify(parsed).slice(0, 300);
}

// ─── RECONCILIATION ─────────────────────────────────────────────────────────

/**
 * Probe Cal.com for the current set of event-type IDs owned by the
 * studio's API key. Returns a Set of valid IDs on success, or `null`
 * when the response is unusable (network error, malformed body, etc.).
 *
 * Returning null on any non-trustworthy outcome is load-bearing —
 * the caller treats null as "skip reconciliation" rather than "Cal
 * has zero events". A misread here would soft-delete the entire
 * menu, so we err aggressively on the side of doing nothing.
 *
 * Response shape per the v2 OpenAPI (GetEventTypesOutput_2024_06_14):
 *   { status: 'success', data: EventTypeOutput_2024_06_14[] }
 * — `data.id` is documented as a number. Hidden event-types are
 * included when the request is authenticated as the owner, which
 * our Bearer flow always is, so our own soft-deleted-via-admin
 * events show up here too (which is what we want — they're not
 * orphans from Cal's perspective).
 */
async function fetchCalEventTypeIds(
  apiKey: string
): Promise<Set<number> | null> {
  try {
    const result = await callCal<{ status?: string; data?: unknown }>(
      '/event-types',
      apiKey,
      { method: 'GET' }
    );
    const events = result.data;
    if (!Array.isArray(events)) {
      console.warn(
        '[services/sync] reconcile: Cal /event-types data was not an array; skipping',
        { kind: typeof events }
      );
      return null;
    }
    const ids = new Set<number>();
    for (const e of events) {
      if (isRecord(e) && typeof e.id === 'number') {
        ids.add(e.id);
      }
    }
    return ids;
  } catch (err) {
    console.warn('[services/sync] reconcile: Cal fetch failed; skipping', {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * PATCH Cal event-types whose booking policy drifts from lib/cal-config.ts
 * (`afterEventBuffer`, `slotInterval`). Best-effort; per-event failures are logged.
 */
/** At most one policy sweep per hour outside admin force-reconcile. */
const BOOKING_POLICY_SYNC_TTL_MS = 60 * 60 * 1000;
let lastBookingPolicySyncAt = 0;

/**
 * Align legacy Cal event-types with studio booking policy (best-effort).
 * Throttled unless `force` — safe to call from manual-booking slot loads.
 */
export async function syncCalEventTypeBookingPoliciesIfStale(
  options: { force?: boolean } = {}
): Promise<void> {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) return;

  const now = Date.now();
  if (!options.force && now - lastBookingPolicySyncAt < BOOKING_POLICY_SYNC_TTL_MS) {
    return;
  }
  lastBookingPolicySyncAt = now;
  await syncCalEventTypeBookingPolicies(apiKey);
}

/** @deprecated Use syncCalEventTypeBookingPoliciesIfStale */
export const syncCalAfterEventBuffersIfStale = syncCalEventTypeBookingPoliciesIfStale;

async function syncCalEventTypeBookingPolicies(apiKey: string): Promise<void> {
  try {
    const result = await callCal<{ status?: string; data?: unknown }>(
      '/event-types',
      apiKey,
      { method: 'GET' }
    );
    const events = result.data;
    if (!Array.isArray(events)) return;

    for (const e of events) {
      if (!isRecord(e) || typeof e.id !== 'number') continue;

      const buf = e.afterEventBuffer;
      const interval = e.slotInterval;
      const needsBuffer =
        typeof buf !== 'number' || buf !== CAL_AFTER_EVENT_BUFFER_MIN;
      const needsInterval = interval !== CAL_SLOT_INTERVAL_MIN;
      if (!needsBuffer && !needsInterval) continue;

      const patch: { afterEventBuffer?: number; slotInterval?: number } = {};
      if (needsBuffer) patch.afterEventBuffer = CAL_AFTER_EVENT_BUFFER_MIN;
      if (needsInterval) patch.slotInterval = CAL_SLOT_INTERVAL_MIN;

      try {
        await callCal(`/event-types/${e.id}`, apiKey, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        console.log('[services/sync] applied event-type booking policy', {
          calEventId: e.id,
          patch,
          was: { afterEventBuffer: buf, slotInterval: interval },
        });
      } catch (err) {
        console.warn('[services/sync] booking policy PATCH failed', {
          calEventId: e.id,
          patch,
          error: errorMessage(err),
        });
      }
    }
  } catch (err) {
    console.warn('[services/sync] booking policy sync skipped', {
      error: errorMessage(err),
    });
  }
}

// Module-scope timestamp of the last reconciliation pass that we
// committed to running (set before the work so concurrent calls
// don't all storm Cal at once). Per-instance — Vercel may have many
// instances, each with its own counter. Worst case under cold starts
// is one extra Cal call per new instance, which is well within
// budget.
let lastReconciledAt = 0;

interface ReconcileOptions {
  /**
   * Bypass the TTL gate. Admin-side render paths set this — the
   * editor expects "I deleted in Cal, refresh shows it" to be
   * immediate, not "within the next minute". The public homepage
   * leaves it unset so it amortises the Cal hit across visitors.
   */
  force?: boolean;
}

/**
 * Best-effort: pull the set of event-types Cal currently has, find
 * any locally-active row whose cal_event_id is no longer in that
 * set, and soft-delete them. This is what closes the loop when the
 * studio deletes a service directly from the Cal.com dashboard —
 * without this pass, the local row stays is_active=TRUE forever and
 * keeps appearing on /admin/services and the public homepage.
 *
 * Three safeguards layered so a misbehaving Cal response can never
 * mass-wipe the menu:
 *
 *   1. fetchCalEventTypeIds() returning null → skip entirely
 *      (network error, missing CAL_API_KEY, malformed body, …).
 *
 *   2. validIds.size === 0 → skip. An empty list from Cal almost
 *      certainly means the key is wrong / authenticating as a
 *      different user / the response shape changed underneath us.
 *      Studios with zero real services are not the failure mode we
 *      want to optimise for.
 *
 *   3. orphanIds.length === active.length → skip. If the
 *      reconciliation would soft-delete EVERY active row at once,
 *      that's a fingerprint of a misread, not a deliberate purge.
 *      Bulk deletes (one or many) still go through, just not "all".
 *
 * Groups (cal_event_id IS NULL) are filtered out by the SQL so they
 * can never be reconciled away — they have no Cal counterpart by
 * design and the homepage relies on them to render the accordion
 * shell.
 *
 * Failures inside the helper are warn-logged but never thrown — the
 * caller pipeline (Server Component, route handler, …) must keep
 * serving its primary content even when Cal is unreachable.
 */
export async function reconcileWithCal(
  options: ReconcileOptions = {}
): Promise<void> {
  const now = Date.now();
  // TTL gate. We update the timestamp BEFORE doing the work so two
  // concurrent calls (e.g. two visitors hitting the homepage in the
  // same tick) don't both make the same Cal round-trip. The trade-
  // off is that a failed reconciliation won't be retried until the
  // next TTL window, which is fine for "best-effort" semantics.
  if (!options.force && now - lastReconciledAt < RECONCILE_TTL_MS) {
    return;
  }
  lastReconciledAt = now;

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) return;

  if (options.force) {
    lastBookingPolicySyncAt = Date.now();
    await syncCalEventTypeBookingPolicies(apiKey);
  }

  const validIds = await fetchCalEventTypeIds(apiKey);
  if (!validIds || validIds.size === 0) return;

  let active: { id: number; cal_event_id: number | null }[];
  try {
    const { rows } = await sql<{
      id: number;
      cal_event_id: number | null;
    }>`
      SELECT id, cal_event_id
      FROM site_services
      WHERE is_active = TRUE AND cal_event_id IS NOT NULL
    `;
    active = rows;
  } catch (err) {
    console.warn('[services/sync] reconcile: db scan failed; skipping', {
      error: errorMessage(err),
    });
    return;
  }
  if (active.length === 0) return;

  const orphanIds = active
    .filter(
      (r) => r.cal_event_id !== null && !validIds.has(r.cal_event_id)
    )
    .map((r) => r.id);

  if (orphanIds.length === 0) return;

  if (orphanIds.length === active.length) {
    console.warn(
      '[services/sync] reconcile: would mass-delete entire menu — skipping (Cal probably misconfigured)',
      { activeCount: active.length, validIdCount: validIds.size }
    );
    return;
  }

  try {
    // sql.query() (positional params) rather than the tagged template
    // because @vercel/postgres' tag doesn't expand JS arrays into a
    // Postgres int[] — see app/admin/website/page.tsx for the same
    // workaround note. Cast to ::int[] explicitly so the planner picks
    // the right comparison.
    await sql.query(
      'UPDATE site_services SET is_active = FALSE WHERE id = ANY($1::int[])',
      [orphanIds]
    );
    console.log('[services/sync] reconcile: soft-deleted orphans', {
      orphanIds,
    });
  } catch (err) {
    console.warn(
      '[services/sync] reconcile: orphan soft-delete failed',
      { orphanIds, error: errorMessage(err) }
    );
  }
}

// ─── LOCAL HELPERS ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
