/**
 * Tiny operational key/value store on the `ops_state` table.
 *
 * Two uses:
 *   • Job heartbeats — cron/QStash-scheduled routes call
 *     `recordJobHeartbeat()` on success so the health check can flag a
 *     scheduler that silently stopped firing (a dead cron produces no
 *     errors anywhere — freshness is the only detectable signal).
 *   • Health-alert cooldown state for /api/cron/health-alert.
 *
 * All helpers are fail-soft: an ops_state outage must never break the
 * job that is reporting into it.
 */

import { sql } from '@vercel/postgres';

export const JOB_HEARTBEAT_KEYS = {
  cleanupAbandoned: 'heartbeat:cleanup-abandoned',
  syncReviews: 'heartbeat:sync-reviews',
  healthAlert: 'heartbeat:health-alert',
  ensureReminders: 'heartbeat:ensure-reminders',
} as const;

export async function setOpsState(
  key: string,
  value: Record<string, unknown>
): Promise<boolean> {
  try {
    await sql`
      INSERT INTO ops_state (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return true;
  } catch (err) {
    console.warn('[ops-state] set failed (non-blocking)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function getOpsState(
  key: string
): Promise<{ value: Record<string, unknown>; updatedAt: Date } | null> {
  try {
    const { rows } = await sql<{
      value: Record<string, unknown>;
      updated_at: Date | string;
    }>`
      SELECT value, updated_at FROM ops_state WHERE key = ${key} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      value: row.value ?? {},
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    };
  } catch (err) {
    console.warn('[ops-state] get failed (non-blocking)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Record a successful job run. Fail-soft. */
export async function recordJobHeartbeat(
  key: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await setOpsState(key, { ...detail, lastRunAt: new Date().toISOString() });
}

export interface HeartbeatAge {
  /** null when the job has never reported. */
  ageMs: number | null;
  lastRunAt: Date | null;
}

export async function getJobHeartbeatAge(key: string): Promise<HeartbeatAge> {
  const row = await getOpsState(key);
  if (!row) return { ageMs: null, lastRunAt: null };
  return {
    ageMs: Date.now() - row.updatedAt.getTime(),
    lastRunAt: row.updatedAt,
  };
}
