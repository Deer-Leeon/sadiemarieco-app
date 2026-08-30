/**
 * Admin health checks — probes env, database, and every external dependency
 * in the booking lifecycle. Used by GET /api/admin/health.
 */

import { clerkClient } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { ALLOWED_ADMIN_EMAILS } from '@/app/admin/auth';
import { CHECKOUT_HOLD_SECONDS } from '@/lib/booking-hold';
import { getJobHeartbeatAge, JOB_HEARTBEAT_KEYS } from '@/lib/ops-state';
import { getQStashBaseUrl, getQStashToken } from '@/lib/qstash-client';
import {
  getCalComApiKey,
  parseAdminOverrideEventId,
} from '@/lib/cal-config';
import { CAL_V2_BASE } from '@/lib/cal-proxy';
import {
  getStripeEnvModes,
  stripeModeMismatchMessage,
} from '@/lib/stripe-mode';
import { stripe } from '@/lib/stripe';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'skipped';

export interface HealthCheckResult {
  id: string;
  name: string;
  category: string;
  status: HealthStatus;
  message: string;
  detail?: string;
  latencyMs?: number;
  /**
   * Tolerated degradation — shown on its own row but excluded from the
   * overall roll-up and from proactive alerts. Used for the Stripe Terminal
   * reader, which is routinely powered off between appointments.
   */
  soft?: boolean;
}

export interface HealthReport {
  checkedAt: string;
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    skipped: number;
    total: number;
  };
  overall: HealthStatus;
  checks: HealthCheckResult[];
}

function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}


async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - start };
}

/** Hard cap on a single third-party probe so a hung socket can't stall the run. */
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_RETRY_GAP_MS = 1_200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for failures that say "try again" rather than "this is broken":
 * timeouts, dropped sockets, rate limits, upstream 5xx.
 */
function isTransientFailure(err: unknown): boolean {
  const status =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status: unknown }).status)
      : NaN;
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return (
    err instanceof Error &&
    /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
      err.message
    )
  );
}

/**
 * Give a flaky dependency one more chance before the probe reports a
 * failure. Cal.com's hosted API stalls past our client timeout every few
 * days; paging the owners on a single sample means a daily alert/recovery
 * pair for something that was already fine on the next run.
 */
async function retryTransient<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientFailure(err)) throw err;
    await sleep(PROBE_RETRY_GAP_MS);
    return fn();
  }
}

function result(
  partial: Omit<HealthCheckResult, 'status'> & { status?: HealthStatus },
  latencyMs?: number
): HealthCheckResult {
  return {
    ...partial,
    status: partial.status ?? 'healthy',
    ...(latencyMs != null ? { latencyMs } : {}),
  };
}

function summarize(checks: HealthCheckResult[]): HealthReport['summary'] {
  const summary = { healthy: 0, degraded: 0, unhealthy: 0, skipped: 0, total: checks.length };
  for (const c of checks) summary[c.status] += 1;
  return summary;
}

/**
 * Overall status ignores `soft` checks — an offline Terminal reader is
 * routine (it sleeps between appointments) and must not turn the whole
 * dashboard amber or fire alerts.
 */
function overallFromChecks(checks: HealthCheckResult[]): HealthStatus {
  const counted = checks.filter((c) => !c.soft);
  if (counted.some((c) => c.status === 'unhealthy')) return 'unhealthy';
  if (counted.some((c) => c.status === 'degraded')) return 'degraded';
  return 'healthy';
}

async function checkEnvironment(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL?.trim() ||
    '';

  const critical = [
    ['CAL_API_KEY', 'Cal.com API key'],
    ['CALCOM_API_KEY', 'Cal.com API key (alias)'],
    ['POSTGRES_URL', 'Postgres connection'],
    ['CLERK_SECRET_KEY', 'Clerk secret key'],
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'Clerk publishable key'],
    ['TWILIO_ACCOUNT_SID', 'Twilio account SID'],
    ['TWILIO_AUTH_TOKEN', 'Twilio auth token'],
    ['TWILIO_PHONE_NUMBER', 'Twilio sender number'],
    ['STRIPE_SECRET_KEY', 'Stripe secret key'],
    ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'Stripe publishable key'],
    ['STRIPE_TERMINAL_READER_ID', 'Stripe Terminal reader ID'],
    ['STRIPE_TERMINAL_LOCATION_ID', 'Stripe Terminal location ID'],
    ['STRIPE_WEBHOOK_SECRET', 'Stripe webhook signing secret'],
    ['RESEND_API_KEY', 'Resend API key'],
    ['QSTASH_TOKEN', 'QStash publish token'],
    ['QSTASH_CURRENT_SIGNING_KEY', 'QStash signing key'],
    ['CRON_SECRET', 'Cron job secret'],
    ['BLOB_READ_WRITE_TOKEN', 'Vercel Blob token'],
    ['CAL_WEBHOOK_SECRET', 'Cal.com webhook HMAC secret'],
  ] as const;

  const calKey = getCalComApiKey();
  const missingCritical: string[] = [];
  for (const [key, label] of critical) {
    if (key === 'CAL_API_KEY' || key === 'CALCOM_API_KEY') {
      if (!calKey) missingCritical.push(label);
      continue;
    }
    if (!envPresent(key)) missingCritical.push(label);
  }

  checks.push(
    result({
      id: 'env-critical',
      name: 'Required environment variables',
      category: 'Environment',
      status: missingCritical.length === 0 ? 'healthy' : 'unhealthy',
      message:
        missingCritical.length === 0
          ? 'All critical secrets are configured'
          : `${missingCritical.length} required variable(s) missing`,
      detail: missingCritical.length ? missingCritical.join(', ') : undefined,
    })
  );

  checks.push(
    result({
      id: 'env-public-base-url',
      name: 'PUBLIC_BASE_URL',
      category: 'Environment',
      status: publicBase ? 'healthy' : 'unhealthy',
      message: publicBase
        ? `Canonical site URL set (${publicBase})`
        : 'PUBLIC_BASE_URL is not set — SMS links, QStash callbacks, and emails may break',
      detail: publicBase || undefined,
    })
  );

  const stripeModes = getStripeEnvModes();
  const stripeMismatch = stripeModeMismatchMessage(stripeModes);
  checks.push(
    result({
      id: 'env-stripe-mode',
      name: 'Stripe key mode (live vs test)',
      category: 'Environment',
      status:
        stripeModes.secret === 'unknown' || stripeModes.publishable === 'unknown'
          ? 'degraded'
          : stripeModes.matchesExpected
            ? 'healthy'
            : 'unhealthy',
      message: stripeModes.matchesExpected
        ? `Stripe ${stripeModes.secret} keys (expected ${stripeModes.expected} for this deployment)`
        : stripeMismatch ||
          `Stripe secret is ${stripeModes.secret}, publishable is ${stripeModes.publishable}`,
      detail: `secret=${stripeModes.secret}, publishable=${stripeModes.publishable}, expected=${stripeModes.expected}`,
    })
  );

  const overrideId = parseAdminOverrideEventId();
  checks.push(
    result({
      id: 'env-cal-admin-override',
      name: 'Admin manual-booking shadow event',
      category: 'Environment',
      status: overrideId != null ? 'healthy' : 'degraded',
      message:
        overrideId != null
          ? `CAL_ADMIN_OVERRIDE_EVENT_ID = ${overrideId}`
          : 'CAL_ADMIN_OVERRIDE_EVENT_ID not set — admin god-mode slots disabled',
    })
  );

  const optional = [
    ['RESEND_FROM_EMAIL', 'Resend from address'],
    ['GOOGLE_PLACES_API_KEY', 'Google Places API key'],
    ['NEXT_PUBLIC_GOOGLE_PLACE_ID', 'Google Place ID'],
    ['CAL_USERNAME', 'Cal.com username slug'],
    ['APNS_KEY_ID', 'Apple Push key id'],
    ['APNS_TEAM_ID', 'Apple Developer team id'],
    ['APNS_P8', 'Apple Push .p8 private key'],
  ] as const;

  const missingOptional = optional.filter(([k]) => !envPresent(k)).map(([, l]) => l);
  checks.push(
    result({
      id: 'env-optional',
      name: 'Optional configuration',
      category: 'Environment',
      status: missingOptional.length === 0 ? 'healthy' : 'degraded',
      message:
        missingOptional.length === 0
          ? 'All optional variables present'
          : `${missingOptional.length} optional variable(s) unset`,
      detail: missingOptional.length ? missingOptional.join(', ') : undefined,
    })
  );

  return checks;
}

async function checkDatabase(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];

  try {
    const { latencyMs } = await timed(async () => {
      await sql`SELECT 1 AS ok`;
    });
    checks.push(
      result(
        {
          id: 'db-connectivity',
          name: 'Postgres connectivity',
          category: 'Database',
          message: 'Database responded to SELECT 1',
        },
        latencyMs
      )
    );
  } catch (err) {
    checks.push(
      result({
        id: 'db-connectivity',
        name: 'Postgres connectivity',
        category: 'Database',
        status: 'unhealthy',
        message: 'Database query failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
    return checks;
  }

  try {
    const { value: templateRows, latencyMs } = await timed(async () => {
      const { rows } = await sql<{ consent_pdf_url: string | null }>`
        SELECT consent_pdf_url
        FROM studio_settings
        WHERE id = 1
        LIMIT 1
      `;
      return rows;
    });
    const url = templateRows[0]?.consent_pdf_url?.trim() || '';
    checks.push(
      result(
        {
          id: 'db-consent-template',
          name: 'Consent PDF template',
          category: 'Database',
          status: url ? 'healthy' : 'unhealthy',
          message: url
            ? 'Consent PDF template is uploaded'
            : 'No consent PDF template in studio_settings — clients cannot sign',
          detail: url || undefined,
        },
        latencyMs
      )
    );
  } catch (err) {
    checks.push(
      result({
        id: 'db-consent-template',
        name: 'Consent PDF template',
        category: 'Database',
        status: 'degraded',
        message: 'Could not read studio_settings consent template',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  try {
    const { value: rows, latencyMs } = await timed(async () => {
      const { rows: r } = await sql<{
        active_services: string;
        pending_holds: string;
        stale_pending: string;
        recent_webhooks: string;
        recent_appointments: string;
        upcoming_confirmed: string;
      }>`
        SELECT
          (SELECT COUNT(*)::text FROM site_services
           WHERE is_active = TRUE AND is_group = FALSE AND cal_event_id IS NOT NULL) AS active_services,
          (SELECT COUNT(*)::text FROM appointments WHERE status = 'pending') AS pending_holds,
          (SELECT COUNT(*)::text FROM appointments
           WHERE status = 'pending'
             AND created_at IS NOT NULL
             AND created_at < NOW() - (${CHECKOUT_HOLD_SECONDS} || ' seconds')::interval) AS stale_pending,
          (SELECT COUNT(*)::text FROM webhook_events
           WHERE processed_at > NOW() - INTERVAL '7 days') AS recent_webhooks,
          (SELECT COUNT(*)::text FROM appointments
           WHERE created_at > NOW() - INTERVAL '7 days'
             AND status NOT IN ('pending', 'canceled_by_system')) AS recent_appointments,
          (SELECT COUNT(*)::text FROM appointments
           WHERE status = 'confirmed' AND booking_time > NOW()) AS upcoming_confirmed
      `;
      return r[0];
    });

    const activeServices = Number(rows?.active_services ?? 0);
    const pendingHolds = Number(rows?.pending_holds ?? 0);
    const stalePending = Number(rows?.stale_pending ?? 0);
    const recentWebhooks = Number(rows?.recent_webhooks ?? 0);
    const recentAppointments = Number(rows?.recent_appointments ?? 0);
    const upcomingConfirmed = Number(rows?.upcoming_confirmed ?? 0);

    checks.push(
      result(
        {
          id: 'db-active-services',
          name: 'Active bookable services',
          category: 'Database',
          status: activeServices > 0 ? 'healthy' : 'unhealthy',
          message:
            activeServices > 0
              ? `${activeServices} active service(s) linked to Cal`
              : 'No active services with Cal event IDs',
        },
        latencyMs
      )
    );

    checks.push(
      result({
        id: 'db-pending-holds',
        name: 'Checkout holds (pending)',
        category: 'Database',
        status: pendingHolds > 20 ? 'degraded' : 'healthy',
        message: `${pendingHolds} pending appointment(s)`,
        detail: `Abandoned holds should clear within ${CHECKOUT_HOLD_SECONDS}s via checkout release, QStash delay, or /api/cron/cleanup-abandoned`,
      })
    );

    checks.push(
      result({
        id: 'db-stale-pending',
        name: 'Stale pending holds',
        category: 'Database',
        status: stalePending > 5 ? 'degraded' : 'healthy',
        message:
          stalePending === 0
            ? `No abandoned checkout holds older than ${CHECKOUT_HOLD_SECONDS}s`
            : `${stalePending} pending hold(s) older than ${CHECKOUT_HOLD_SECONDS}s`,
        detail:
          stalePending > 0
            ? 'Hit GET /api/cron/cleanup-abandoned with CRON_SECRET, and verify QSTASH_URL matches your Upstash region'
            : undefined,
      })
    );

    // Quiet periods (no bookings) are healthy. Only flag when appointments
    // landed but nothing hit webhook_events (dedupe / SMS / email paths).
    const webhookStatus =
      recentWebhooks > 0
        ? 'healthy'
        : recentAppointments === 0
          ? 'healthy'
          : 'degraded';
    checks.push(
      result({
        id: 'db-webhook-activity',
        name: 'Recent webhook processing',
        category: 'Database',
        status: webhookStatus,
        message:
          recentWebhooks > 0
            ? `${recentWebhooks} webhook event(s) in the last 7 days`
            : recentAppointments === 0
              ? 'No recent bookings or webhook events (quiet period)'
              : `${recentAppointments} appointment(s) in the last 7 days but 0 webhook_events`,
        detail: 'Includes Cal webhook dedup and email idempotency keys',
      })
    );

    checks.push(
      result({
        id: 'db-upcoming-bookings',
        name: 'Upcoming confirmed bookings',
        category: 'Database',
        status: 'healthy',
        message: `${upcomingConfirmed} confirmed appointment(s) in the future`,
      })
    );
  } catch (err) {
    checks.push(
      result({
        id: 'db-metrics',
        name: 'Booking data metrics',
        category: 'Database',
        status: 'unhealthy',
        message: 'Failed to read booking metrics',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return checks;
}

async function checkCalCom(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const apiKey = getCalComApiKey();

  if (!apiKey) {
    checks.push(
      result({
        id: 'cal-api-key',
        name: 'Cal.com API authentication',
        category: 'Cal.com',
        status: 'unhealthy',
        message: 'CAL_API_KEY / CALCOM_API_KEY is not configured',
      })
    );
    return checks;
  }

  try {
    const { value: payload, latencyMs } = await timed(() =>
      retryTransient(async () => {
        const res = await fetch(`${CAL_V2_BASE}/event-types`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'cal-api-version': '2024-06-14',
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const msg =
            body && typeof body === 'object' && 'message' in body
              ? String((body as { message: unknown }).message)
              : `HTTP ${res.status}`;
          throw Object.assign(new Error(msg), { status: res.status });
        }
        return body;
      })
    );

    const eventTypes = extractCalEventTypes(payload);
    checks.push(
      result(
        {
          id: 'cal-api-auth',
          name: 'Cal.com API authentication',
          category: 'Cal.com',
          message: `Connected — ${eventTypes.length} event type(s) visible`,
        },
        latencyMs
      )
    );

    const overrideId = parseAdminOverrideEventId();
    if (overrideId != null) {
      const found = eventTypes.some((et) => et.id === overrideId);
      checks.push(
        result({
          id: 'cal-admin-override-event',
          name: 'Admin shadow event type',
          category: 'Cal.com',
          status: found ? 'healthy' : 'unhealthy',
          message: found
            ? `Shadow event ${overrideId} exists in Cal`
            : `CAL_ADMIN_OVERRIDE_EVENT_ID ${overrideId} not found in Cal`,
        })
      );
    }

    try {
      const { rows } = await sql<{ cal_event_id: number; title: string }>`
        SELECT cal_event_id, title
        FROM site_services
        WHERE is_active = TRUE
          AND is_group = FALSE
          AND cal_event_id IS NOT NULL
      `;
      const calIds = new Set(eventTypes.map((et) => et.id));
      const orphans = rows.filter((r) => !calIds.has(r.cal_event_id));
      checks.push(
        result({
          id: 'cal-service-sync',
          name: 'Service catalogue ↔ Cal sync',
          category: 'Cal.com',
          status: orphans.length === 0 ? 'healthy' : 'degraded',
          message:
            orphans.length === 0
              ? `${rows.length} local service(s) match Cal event types`
              : `${orphans.length} local service(s) missing from Cal`,
          detail:
            orphans.length > 0
              ? orphans.map((o) => `${o.title} (id ${o.cal_event_id})`).join(', ')
              : undefined,
        })
      );
    } catch (err) {
      checks.push(
        result({
          id: 'cal-service-sync',
          name: 'Service catalogue ↔ Cal sync',
          category: 'Cal.com',
          status: 'degraded',
          message: 'Could not compare local services to Cal',
          detail: err instanceof Error ? err.message : String(err),
        })
      );
    }

    try {
      const { fetchDefaultSchedule } = await import(
        '@/app/admin/availability/calSchedules'
      );
      const { value: schedule, latencyMs: scheduleMs } = await timed(() =>
        retryTransient(() => fetchDefaultSchedule(apiKey))
      );
      const windows = Array.isArray(schedule.availability)
        ? schedule.availability.length
        : 0;
      checks.push(
        result(
          {
            id: 'cal-schedules',
            name: 'Cal.com default schedule (homepage hours)',
            category: 'Cal.com',
            status: windows > 0 ? 'healthy' : 'degraded',
            message:
              windows > 0
                ? `Default schedule loaded (${windows} weekly window(s))`
                : 'Default schedule has no weekly availability windows',
            detail: schedule.name ? `schedule=${schedule.name}` : undefined,
          },
          scheduleMs
        )
      );
    } catch (err) {
      checks.push(
        result({
          id: 'cal-schedules',
          name: 'Cal.com default schedule (homepage hours)',
          category: 'Cal.com',
          status: 'unhealthy',
          message: 'Could not load Cal.com default schedule',
          detail: err instanceof Error ? err.message : String(err),
        })
      );
    }

    try {
      const { latencyMs: embedMs } = await timed(async () => {
        const res = await fetch('https://app.cal.com/embed/embed.js', {
          method: 'HEAD',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
      checks.push(
        result(
          {
            id: 'cal-embed-cdn',
            name: 'Cal.com embed script (public site)',
            category: 'Cal.com',
            message: 'embed.js reachable from app.cal.com',
          },
          embedMs
        )
      );
    } catch (err) {
      checks.push(
        result({
          id: 'cal-embed-cdn',
          name: 'Cal.com embed script (public site)',
          category: 'Cal.com',
          status: 'degraded',
          message: 'Could not reach Cal embed CDN',
          detail: err instanceof Error ? err.message : String(err),
        })
      );
    }
  } catch (err) {
    checks.push(
      result({
        id: 'cal-api-auth',
        name: 'Cal.com API authentication',
        category: 'Cal.com',
        status: 'unhealthy',
        message: 'Cal.com API request failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return checks;
}

function extractCalEventTypes(payload: unknown): Array<{ id: number; title: string }> {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const data = root.data;
  const list = Array.isArray(data) ? data : [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'number' ? rec.id : Number(rec.id);
      const title = typeof rec.title === 'string' ? rec.title : '';
      if (!Number.isFinite(id) || id <= 0) return null;
      return { id, title };
    })
    .filter((x): x is { id: number; title: string } => x != null);
}

/** Probe POST /emails with an invalid payload — auth succeeds on 400/422 without sending mail. */
async function probeResendSendingAccess(apiKey: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sadiemarie-health-check/1.0',
    },
    body: '{}',
    cache: 'no-store',
  });

  if (res.status === 401) {
    let detail = 'Invalid API key';
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      // keep default
    }
    throw new Error(detail);
  }

  // Validation errors mean the key authenticated against the send endpoint.
  if (res.status === 400 || res.status === 422) return;

  if (res.ok) {
    throw new Error('Unexpected success from send probe');
  }

  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = body.message;
  } catch {
    // keep status-only detail
  }
  throw new Error(detail);
}

async function checkResend(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    return [
      result({
        id: 'resend-api-key',
        name: 'Resend API key',
        category: 'Email (Resend)',
        status: 'unhealthy',
        message: 'RESEND_API_KEY is not set — confirmation emails will not send',
      }),
    ];
  }

  try {
    const { latencyMs } = await timed(async () => {
      await probeResendSendingAccess(apiKey);
    });

    const fromEmail =
      process.env.RESEND_FROM_EMAIL?.trim() || 'Sadie Marie <bookings@sadiemarie.co>';

    checks.push(
      result(
        {
          id: 'resend-api',
          name: 'Resend send API',
          category: 'Email (Resend)',
          message: 'Sending API key valid — confirmation emails can be sent',
        },
        latencyMs
      )
    );

    checks.push(
      result({
        id: 'resend-from',
        name: 'Confirmation email sender',
        category: 'Email (Resend)',
        status: 'healthy',
        message: `From address: ${fromEmail}`,
        detail: 'Custom Sadie Marie HTML template via lib/email-templates.ts',
      })
    );
  } catch (err) {
    checks.push(
      result({
        id: 'resend-api',
        name: 'Resend send API',
        category: 'Email (Resend)',
        status: 'unhealthy',
        message: 'Resend send check failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return checks;
}

async function checkTwilio(): Promise<HealthCheckResult[]> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();

  if (!sid || !token || !from) {
    return [
      result({
        id: 'twilio-config',
        name: 'Twilio configuration',
        category: 'SMS (Twilio)',
        status: 'unhealthy',
        message: 'Twilio env vars incomplete — confirmation SMS and reminders will not send',
      }),
    ];
  }

  try {
    const { latencyMs } = await timed(async () => {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`;
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status?: string };
      if (body.status && body.status !== 'active') {
        throw new Error(`Account status: ${body.status}`);
      }
    });

    return [
      result(
        {
          id: 'twilio-account',
          name: 'Twilio account',
          category: 'SMS (Twilio)',
          message: `Account active — sender ${from}`,
          detail: 'Used for booking confirmation, 24h reminders, and feedback SMS',
        },
        latencyMs
      ),
    ];
  } catch (err) {
    return [
      result({
        id: 'twilio-account',
        name: 'Twilio account',
        category: 'SMS (Twilio)',
        status: 'unhealthy',
        message: 'Twilio API check failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
}

async function checkStripe(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const client = stripe;
  if (!client) {
    return [
      result({
        id: 'stripe-client',
        name: 'Stripe API',
        category: 'Payments (Stripe)',
        status: 'unhealthy',
        message: 'STRIPE_SECRET_KEY is not set — checkout and card vault will fail',
      }),
    ];
  }

  try {
    const { latencyMs } = await timed(async () => {
      await client.balance.retrieve();
    });
    checks.push(
      result(
        {
          id: 'stripe-api',
          name: 'Stripe API',
          category: 'Payments (Stripe)',
          message: 'Stripe API reachable — used for checkout vault, no-show, and late-cancel fees',
        },
        latencyMs
      )
    );
  } catch (err) {
    checks.push(
      result({
        id: 'stripe-api',
        name: 'Stripe API',
        category: 'Payments (Stripe)',
        status: 'unhealthy',
        message: 'Stripe balance.retrieve() failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
    return checks;
  }

  const readerId = process.env.STRIPE_TERMINAL_READER_ID?.trim() || '';
  const locationId =
    process.env.STRIPE_TERMINAL_LOCATION_ID?.trim() || '';
  if (!readerId) {
    checks.push(
      result({
        id: 'stripe-terminal-reader',
        name: 'Stripe Terminal S710',
        category: 'Payments (Stripe)',
        status: 'unhealthy',
        message: 'STRIPE_TERMINAL_READER_ID is not configured',
      })
    );
    return checks;
  }

  try {
    const { value: reader, latencyMs } = await timed(() =>
      client.terminal.readers.retrieve(readerId)
    );
    if ('deleted' in reader && reader.deleted) {
      checks.push(
        result(
          {
            id: 'stripe-terminal-reader',
            name: 'Stripe Terminal S710',
            category: 'Payments (Stripe)',
            status: 'unhealthy',
            message: 'Configured Terminal reader was deleted',
            detail: readerId,
          },
          latencyMs
        )
      );
      return checks;
    }

    const actualLocation =
      typeof reader.location === 'string'
        ? reader.location
        : reader.location?.id || null;
    const modes = getStripeEnvModes();
    const readerMode = reader.livemode ? 'live' : 'test';
    const modeMatches = readerMode === modes.expected;
    const locationMatches =
      !locationId || actualLocation === locationId;
    const online = reader.status === 'online';

    checks.push(
      result(
        {
          id: 'stripe-terminal-reader',
          name: 'Stripe Terminal S710',
          category: 'Payments (Stripe)',
          status:
            modeMatches && locationMatches && online
              ? 'healthy'
              : !modeMatches || !locationMatches
                ? 'unhealthy'
                : 'degraded',
          // Offline reader is routine (it sleeps between appointments) —
          // soft so it never flips the overall status or fires alerts.
          // Mode/location mismatch stays hard (real misconfiguration).
          soft: modeMatches && locationMatches && !online,
          message: online
            ? `${reader.label || reader.id} online (${readerMode} mode)`
            : `${reader.label || reader.id} is ${reader.status || 'offline'} — normal when powered down; does not affect overall status`,
          detail: [
            `reader=${reader.id}`,
            `device=${reader.device_type}`,
            `location=${actualLocation || 'none'}`,
            `expected_location=${locationId || 'not set'}`,
            `mode=${readerMode}`,
            `expected_mode=${modes.expected}`,
          ].join(', '),
        },
        latencyMs
      )
    );
  } catch (err) {
    checks.push(
      result({
        id: 'stripe-terminal-reader',
        name: 'Stripe Terminal S710',
        category: 'Payments (Stripe)',
        status: 'unhealthy',
        message: 'Could not retrieve the configured Terminal reader',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  checks.push(
    result({
      id: 'stripe-terminal-webhook',
      name: 'Stripe Terminal webhook',
      category: 'Payments (Stripe)',
      status: envPresent('STRIPE_WEBHOOK_SECRET') ? 'healthy' : 'unhealthy',
      message: envPresent('STRIPE_WEBHOOK_SECRET')
        ? 'Webhook signing secret configured'
        : 'STRIPE_WEBHOOK_SECRET missing — interrupted payments cannot reconcile',
      detail: '/api/stripe/webhook',
    })
  );

  return checks;
}

/** Production base used to validate QStash schedules + Cal webhook targets. */
const PRODUCTION_BASE = 'https://www.sadiemarie.co';

async function checkQStash(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const token = getQStashToken();
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  const publicBase = (process.env.PUBLIC_BASE_URL?.trim() || '').replace(
    /\/$/,
    ''
  );
  const qstashUrl = getQStashBaseUrl();

  if (!token) {
    checks.push(
      result({
        id: 'qstash-api',
        name: 'QStash API',
        category: 'Scheduled jobs (QStash)',
        status: 'unhealthy',
        message: 'QSTASH_TOKEN missing — reminder/feedback SMS and abandoned-hold release will not be scheduled',
      })
    );
  } else {
    // Live probe: an env-only check shows green while a wrong-region
    // QSTASH_URL 404s every publish. Listing schedules exercises token +
    // region and returns the recurring schedules for validation.
    try {
      const { value: schedules, latencyMs } = await timed(async () => {
        const res = await fetch(`${qstashUrl}/v2/schedules`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json().catch(() => []);
        return Array.isArray(body)
          ? (body as Array<{ destination?: string; cron?: string }>)
          : [];
      });

      checks.push(
        result(
          {
            id: 'qstash-api',
            name: 'QStash API',
            category: 'Scheduled jobs (QStash)',
            message: `Connected (${qstashUrl}) — ${schedules.length} recurring schedule(s)`,
            detail:
              'Publishes reminder/feedback SMS, reminder emails, and delayed hold release',
          },
          latencyMs
        )
      );

      // Recurring schedules should exist on production for the safety
      // sweeps. Only meaningful against the production destination.
      if (!publicBase || publicBase === PRODUCTION_BASE) {
        const destinations = schedules
          .map((s) => (s.destination || '').replace(/\/$/, ''))
          .filter(Boolean);
        const expected: Array<[string, string]> = [
          [`${PRODUCTION_BASE}/api/cron/cleanup-abandoned`, 'abandoned-hold sweep'],
          [`${PRODUCTION_BASE}/api/cron/health-alert`, 'health alert'],
          [`${PRODUCTION_BASE}/api/cron/sync-reviews`, 'reviews sync'],
        ];
        const missing = expected
          .filter(([url]) => !destinations.includes(url))
          .map(([, label]) => label);
        checks.push(
          result({
            id: 'qstash-recurring-schedules',
            name: 'Recurring QStash schedules',
            category: 'Scheduled jobs (QStash)',
            status: missing.length === 0 ? 'healthy' : 'degraded',
            message:
              missing.length === 0
                ? 'Hold sweep, health alert, and reviews sync are scheduled'
                : `Missing schedule(s): ${missing.join(', ')}`,
            detail:
              missing.length > 0
                ? 'Run: node --env-file=.env.local scripts/setup-qstash-schedules.mjs'
                : undefined,
          })
        );
      }
    } catch (err) {
      checks.push(
        result({
          id: 'qstash-api',
          name: 'QStash API',
          category: 'Scheduled jobs (QStash)',
          status: 'unhealthy',
          message: 'QStash API request failed — reminders and hold release will not schedule',
          detail: `${qstashUrl} — ${err instanceof Error ? err.message : String(err)}. Check QSTASH_TOKEN and that QSTASH_URL matches your Upstash region.`,
        })
      );
    }
  }

  checks.push(
    result({
      id: 'qstash-signing-keys',
      name: 'QStash webhook verification',
      category: 'Scheduled jobs (QStash)',
      status: currentKey ? 'healthy' : 'unhealthy',
      message: currentKey
        ? nextKey
          ? 'Signing key set (rotation key also configured)'
          : 'Signing key set'
        : 'QSTASH_CURRENT_SIGNING_KEY missing — QStash callbacks will reject',
    })
  );

  if (publicBase) {
    checks.push(
      result({
        id: 'qstash-callback-urls',
        name: 'QStash callback URLs',
        category: 'Scheduled jobs (QStash)',
        status: 'healthy',
        message: 'Reminder, feedback, reminder-email, and hold-release endpoints',
        detail: `${publicBase}/api/remind · ${publicBase}/api/feedback · ${publicBase}/api/remind-email · ${publicBase}/api/qstash/release-hold`,
      })
    );
  }

  return checks;
}

async function checkWebhooks(): Promise<HealthCheckResult[]> {
  const apiKey = getCalComApiKey();
  const expectedUrl = `${PRODUCTION_BASE}/api/webhook`;

  if (!apiKey) {
    return [
      result({
        id: 'webhook-cal-registered',
        name: 'Cal.com webhook registration',
        category: 'Webhooks',
        status: 'unhealthy',
        message: 'Cannot verify — Cal API key missing',
      }),
    ];
  }

  // Live probe: CAL_WEBHOOK_SECRET being set does not prove Cal actually has
  // a webhook pointing at this app. If someone deletes/disables it in the
  // Cal dashboard, every booking silently loses SMS/email/DB lifecycle.
  // Uses API v2 — v1 was decommissioned (HTTP 410) in 2026.
  try {
    const { value: hooks, latencyMs } = await timed(async () => {
      const res = await fetch('https://api.cal.com/v2/webhooks', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => null)) as {
        data?: Array<{
          subscriberUrl?: string;
          active?: boolean;
          triggers?: string[];
        }>;
      } | null;
      return Array.isArray(body?.data) ? body.data : [];
    });

    const match = hooks.find(
      (h) => (h.subscriberUrl || '').replace(/\/$/, '') === expectedUrl
    );
    if (!match) {
      return [
        result(
          {
            id: 'webhook-cal-registered',
            name: 'Cal.com webhook registration',
            category: 'Webhooks',
            status: 'unhealthy',
            message: `No Cal webhook targets ${expectedUrl} — booking SMS, emails, and cancel fees will not fire`,
            detail: `Cal has ${hooks.length} webhook(s): ${hooks.map((h) => h.subscriberUrl).join(', ') || 'none'}`,
          },
          latencyMs
        ),
      ];
    }
    if (match.active === false) {
      return [
        result(
          {
            id: 'webhook-cal-registered',
            name: 'Cal.com webhook registration',
            category: 'Webhooks',
            status: 'unhealthy',
            message: 'Cal webhook exists but is DISABLED — enable it in the Cal.com dashboard',
            detail: expectedUrl,
          },
          latencyMs
        ),
      ];
    }

    const triggers = match.triggers ?? [];
    const wanted = ['BOOKING_CREATED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED'];
    const missingTriggers = wanted.filter((t) => !triggers.includes(t));
    return [
      result(
        {
          id: 'webhook-cal-registered',
          name: 'Cal.com webhook registration',
          category: 'Webhooks',
          status: missingTriggers.length === 0 ? 'healthy' : 'degraded',
          message:
            missingTriggers.length === 0
              ? `Active Cal webhook → ${expectedUrl}`
              : `Webhook active but missing trigger(s): ${missingTriggers.join(', ')}`,
          detail: triggers.length ? `triggers: ${triggers.join(', ')}` : undefined,
        },
        latencyMs
      ),
    ];
  } catch (err) {
    return [
      result({
        id: 'webhook-cal-registered',
        name: 'Cal.com webhook registration',
        category: 'Webhooks',
        status: 'degraded',
        message: 'Could not verify Cal webhook registration',
        detail: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
}

function humanizeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * A dead scheduler produces no errors anywhere — the only detectable signal
 * is that its heartbeat stops advancing. Each job writes `ops_state` on a
 * successful run (lib/ops-state.ts).
 */
async function checkJobFreshness(): Promise<HealthCheckResult[]> {
  const jobs: Array<{
    id: string;
    name: string;
    key: string;
    /** ms after which the job counts as stale (degraded). */
    warnAfterMs: number;
    /** ms after which the job counts as dead (unhealthy). Optional. */
    failAfterMs?: number;
    whatBreaks: string;
  }> = [
    {
      id: 'job-cleanup-abandoned',
      name: 'Abandoned hold sweep (last run)',
      key: JOB_HEARTBEAT_KEYS.cleanupAbandoned,
      // Daily midnight MT job — do not reuse the hourly 2h window or it
      // stays DEGRADED all afternoon after a successful run.
      warnAfterMs: 26 * 60 * 60 * 1000,
      failAfterMs: 50 * 60 * 60 * 1000,
      whatBreaks:
        'Stale checkout holds can block calendar slots. Scheduled once at midnight MT via QStash + a daily Vercel Cron backstop.',
    },
    {
      id: 'job-health-alert',
      name: 'Health alert monitor (last run)',
      key: JOB_HEARTBEAT_KEYS.healthAlert,
      warnAfterMs: 2 * 60 * 60 * 1000,
      failAfterMs: 12 * 60 * 60 * 1000,
      whatBreaks:
        'Nobody is notified when a dependency goes down. Scheduled hourly via QStash.',
    },
    {
      id: 'job-sync-reviews',
      name: 'Google reviews sync (last run)',
      key: JOB_HEARTBEAT_KEYS.syncReviews,
      warnAfterMs: 30 * 60 * 60 * 1000,
      whatBreaks:
        'Homepage review carousel goes stale. Scheduled daily via QStash.',
    },
  ];

  const checks: HealthCheckResult[] = [];
  for (const job of jobs) {
    const { ageMs, lastRunAt } = await getJobHeartbeatAge(job.key);
    if (ageMs == null) {
      checks.push(
        result({
          id: job.id,
          name: job.name,
          category: 'Cron jobs',
          status: 'degraded',
          message: 'Never run (no heartbeat recorded yet)',
          detail: `${job.whatBreaks} Set up schedules with scripts/setup-qstash-schedules.mjs.`,
        })
      );
      continue;
    }
    const status =
      job.failAfterMs != null && ageMs > job.failAfterMs
        ? 'unhealthy'
        : ageMs > job.warnAfterMs
          ? 'degraded'
          : 'healthy';
    checks.push(
      result({
        id: job.id,
        name: job.name,
        category: 'Cron jobs',
        status,
        message:
          status === 'healthy'
            ? `Last ran ${humanizeAge(ageMs)}`
            : `STALE — last ran ${humanizeAge(ageMs)} (${lastRunAt?.toISOString() ?? 'unknown'})`,
        detail: status === 'healthy' ? undefined : job.whatBreaks,
      })
    );
  }
  return checks;
}

async function checkCron(): Promise<HealthCheckResult[]> {
  const publicBase = (
    process.env.PUBLIC_BASE_URL?.trim() || PRODUCTION_BASE
  ).replace(/\/$/, '');
  const cronSecret = process.env.CRON_SECRET?.trim();

  const checks: HealthCheckResult[] = [
    result({
      id: 'cron-secret',
      name: 'Cron authentication',
      category: 'Cron jobs',
      status: cronSecret ? 'healthy' : 'unhealthy',
      message: cronSecret
        ? 'CRON_SECRET configured'
        : 'CRON_SECRET missing — scheduled jobs cannot run',
    }),
    result({
      id: 'qstash-release-hold',
      name: 'Abandoned checkout release',
      category: 'Scheduled jobs (QStash)',
      status: process.env.QSTASH_TOKEN?.trim() ? 'healthy' : 'degraded',
      message: `Delayed QStash + checkout timer + recurring sweep (${CHECKOUT_HOLD_SECONDS}s hold)`,
      detail: `${publicBase}/api/qstash/release-hold · ${publicBase}/api/booking/release-hold · ${publicBase}/api/cron/cleanup-abandoned`,
    }),
  ];

  checks.push(...(await checkJobFreshness()));

  return checks;
}

async function checkBlob(): Promise<HealthCheckResult[]> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    return [
      result({
        id: 'blob-token',
        name: 'Vercel Blob storage',
        category: 'Storage',
        status: 'unhealthy',
        message: 'BLOB_READ_WRITE_TOKEN missing — consent PDFs and CMS uploads will fail',
      }),
    ];
  }

  // Live probe: a present-but-revoked token would otherwise show green while
  // consent-PDF stamping and CMS uploads fail at runtime.
  try {
    const { list } = await import('@vercel/blob');
    const { latencyMs } = await timed(async () => {
      await list({ limit: 1, token });
    });
    return [
      result(
        {
          id: 'blob-api',
          name: 'Vercel Blob storage',
          category: 'Storage',
          message: 'Blob API reachable with the configured token',
          detail: 'Used for consent PDF stamping, client photos, and website CMS images',
        },
        latencyMs
      ),
    ];
  } catch (err) {
    return [
      result({
        id: 'blob-api',
        name: 'Vercel Blob storage',
        category: 'Storage',
        status: 'unhealthy',
        message: 'Blob API check failed — consent PDFs and CMS uploads will fail',
        detail: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
}

async function checkGoogleReviews(): Promise<HealthCheckResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  const placeId = process.env.NEXT_PUBLIC_GOOGLE_PLACE_ID?.trim();

  if (!apiKey || !placeId) {
    return [
      result({
        id: 'google-reviews',
        name: 'Google Places reviews',
        category: 'Reviews',
        status: 'skipped',
        message: 'Google Places env not configured — reviews sync disabled',
      }),
    ];
  }

  try {
    const { latencyMs } = await timed(async () => {
      const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      url.searchParams.set('place_id', placeId);
      url.searchParams.set('fields', 'reviews');
      url.searchParams.set('key', apiKey);
      url.searchParams.set('reviews_no_translations', 'true');
      const res = await fetch(url.toString(), { cache: 'no-store' });
      const body = (await res.json()) as { status?: string; error_message?: string };
      if (body.status !== 'OK') {
        throw new Error(body.error_message || body.status || 'Places API error');
      }
    });

    let dbCount = 0;
    try {
      const { rows } = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM google_reviews
      `;
      dbCount = Number(rows[0]?.count ?? 0);
    } catch {
      // non-fatal
    }

    return [
      result(
        {
          id: 'google-places-api',
          name: 'Google Places API',
          category: 'Reviews',
          message: `Places API OK — ${dbCount} review(s) cached locally`,
        },
        latencyMs
      ),
    ];
  } catch (err) {
    return [
      result({
        id: 'google-places-api',
        name: 'Google Places API',
        category: 'Reviews',
        status: 'unhealthy',
        message: 'Google Places API check failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
}

async function checkClerk(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];

  if (!envPresent('CLERK_SECRET_KEY') || !envPresent('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) {
    return [
      result({
        id: 'clerk-config',
        name: 'Clerk authentication',
        category: 'Admin auth',
        status: 'unhealthy',
        message: 'Clerk keys missing — admin dashboard will not work',
      }),
    ];
  }

  try {
    const { latencyMs } = await timed(async () => {
      const client = await clerkClient();
      await client.users.getUserList({ limit: 1 });
    });
    checks.push(
      result(
        {
          id: 'clerk-api',
          name: 'Clerk API',
          category: 'Admin auth',
          message: 'Clerk backend API reachable',
        },
        latencyMs
      )
    );
  } catch (err) {
    checks.push(
      result({
        id: 'clerk-api',
        name: 'Clerk API',
        category: 'Admin auth',
        status: 'unhealthy',
        message: 'Clerk API check failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }

  checks.push(
    result({
      id: 'clerk-allowlist',
      name: 'Admin email allowlist',
      category: 'Admin auth',
      status: 'healthy',
      message: `${ALLOWED_ADMIN_EMAILS.size} authorized admin email(s)`,
      detail: [...ALLOWED_ADMIN_EMAILS].join(', '),
    })
  );

  return checks;
}

async function checkBookingPipeline(): Promise<HealthCheckResult[]> {
  const publicBase = (
    process.env.PUBLIC_BASE_URL?.trim() || 'https://www.sadiemarie.co'
  ).replace(/\/$/, '');

  return [
    result({
      id: 'flow-public-booking',
      name: 'Public booking flow',
      category: 'Booking pipeline',
      status: 'healthy',
      message: 'Cal embed → POST /api/booking/init → Stripe checkout → POST /api/booking/confirm',
      detail: `${publicBase}/checkout`,
    }),
    result({
      id: 'flow-admin-booking',
      name: 'Admin manual booking',
      category: 'Booking pipeline',
      status: parseAdminOverrideEventId() != null ? 'healthy' : 'degraded',
      message:
        'Admin modal → POST /api/admin/manual-booking/create → POST /api/admin/manual-booking/complete',
      detail: 'Sends Sadie Marie confirmation email + SMS on complete',
    }),
    result({
      id: 'flow-consent',
      name: 'Client intake / consent',
      category: 'Booking pipeline',
      status: envPresent('BLOB_READ_WRITE_TOKEN') ? 'healthy' : 'degraded',
      message: 'GET/POST /api/consent/[clientId] — stamped PDF to Blob',
      detail: `${publicBase}/consent/{clientId}`,
    }),
    result({
      id: 'flow-manage',
      name: 'Client self-service portal',
      category: 'Booking pipeline',
      status: 'healthy',
      message: 'manage.html — cancel/reschedule via Cal booking UID',
      detail: `${publicBase}/manage.html?uid={bookingUid}`,
    }),
  ];
}

/** Run every health probe and return a structured report. */
export async function runHealthChecks(): Promise<HealthReport> {
  const groups = await Promise.all([
    checkEnvironment(),
    checkDatabase(),
    checkBookingPipeline(),
    checkCalCom(),
    checkWebhooks(),
    checkResend(),
    checkTwilio(),
    checkStripe(),
    checkQStash(),
    checkCron(),
    checkBlob(),
    checkGoogleReviews(),
    checkClerk(),
  ]);

  const checks = groups.flat();
  const summary = summarize(checks);

  return {
    checkedAt: new Date().toISOString(),
    summary,
    overall: overallFromChecks(checks),
    checks,
  };
}
