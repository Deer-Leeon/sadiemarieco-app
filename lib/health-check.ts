/**
 * Admin health checks — probes env, database, and every external dependency
 * in the booking lifecycle. Used by GET /api/admin/health.
 */

import { clerkClient } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';

import { ALLOWED_ADMIN_EMAILS } from '@/app/admin/auth';
import { CHECKOUT_HOLD_SECONDS } from '@/lib/booking-hold';
import { getQStashBaseUrl, getQStashToken } from '@/lib/qstash-client';
import {
  getCalComApiKey,
  parseAdminOverrideEventId,
} from '@/lib/cal-config';
import { CAL_V2_BASE } from '@/lib/cal-proxy';
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

function stripeKeyMode(key: string | undefined): 'live' | 'test' | 'unknown' {
  if (!key) return 'unknown';
  if (key.startsWith('sk_live_') || key.startsWith('pk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('pk_test_')) return 'test';
  return 'unknown';
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - start };
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

function overallFromSummary(summary: HealthReport['summary']): HealthStatus {
  if (summary.unhealthy > 0) return 'unhealthy';
  if (summary.degraded > 0) return 'degraded';
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
    ['RESEND_API_KEY', 'Resend API key'],
    ['QSTASH_TOKEN', 'QStash publish token'],
    ['QSTASH_CURRENT_SIGNING_KEY', 'QStash signing key'],
    ['CRON_SECRET', 'Cron job secret'],
    ['BLOB_READ_WRITE_TOKEN', 'Vercel Blob token'],
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

  const secretMode = stripeKeyMode(process.env.STRIPE_SECRET_KEY);
  const publishableMode = stripeKeyMode(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  const stripeAligned =
    secretMode !== 'unknown' &&
    publishableMode !== 'unknown' &&
    secretMode === publishableMode;

  checks.push(
    result({
      id: 'env-stripe-mode',
      name: 'Stripe key mode alignment',
      category: 'Environment',
      status:
        secretMode === 'unknown' || publishableMode === 'unknown'
          ? 'degraded'
          : stripeAligned
            ? 'healthy'
            : 'unhealthy',
      message: stripeAligned
        ? `Stripe keys aligned (${secretMode} mode)`
        : `Stripe secret is ${secretMode}, publishable is ${publishableMode}`,
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
    const { value: rows, latencyMs } = await timed(async () => {
      const { rows: r } = await sql<{
        active_services: string;
        pending_holds: string;
        stale_pending: string;
        recent_webhooks: string;
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
           WHERE status = 'confirmed' AND booking_time > NOW()) AS upcoming_confirmed
      `;
      return r[0];
    });

    const activeServices = Number(rows?.active_services ?? 0);
    const pendingHolds = Number(rows?.pending_holds ?? 0);
    const stalePending = Number(rows?.stale_pending ?? 0);
    const recentWebhooks = Number(rows?.recent_webhooks ?? 0);
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

    checks.push(
      result({
        id: 'db-webhook-activity',
        name: 'Recent webhook processing',
        category: 'Database',
        status: recentWebhooks > 0 ? 'healthy' : 'degraded',
        message:
          recentWebhooks > 0
            ? `${recentWebhooks} webhook event(s) in the last 7 days`
            : 'No webhook_events rows in the last 7 days',
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
    const { value: payload, latencyMs } = await timed(async () => {
      const res = await fetch(`${CAL_V2_BASE}/event-types`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': '2024-06-14',
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message: unknown }).message)
            : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return body;
    });

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
    return [
      result(
        {
          id: 'stripe-api',
          name: 'Stripe API',
          category: 'Payments (Stripe)',
          message: 'Stripe API reachable — used for checkout vault, no-show, and late-cancel fees',
        },
        latencyMs
      ),
    ];
  } catch (err) {
    return [
      result({
        id: 'stripe-api',
        name: 'Stripe API',
        category: 'Payments (Stripe)',
        status: 'unhealthy',
        message: 'Stripe balance.retrieve() failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
}

async function checkQStash(): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const token = getQStashToken();
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  const publicBase = process.env.PUBLIC_BASE_URL?.trim() || '';
  const qstashUrl = getQStashBaseUrl();
  const qstashUrlFromEnv = Boolean(process.env.QSTASH_URL?.trim());

  if (!token) {
    checks.push(
      result({
        id: 'qstash-token',
        name: 'QStash publish token',
        category: 'Scheduled jobs (QStash)',
        status: 'unhealthy',
        message: 'QSTASH_TOKEN missing — reminder/feedback SMS and abandoned-hold release will not be scheduled',
      })
    );
  } else {
    checks.push(
      result({
        id: 'qstash-token',
        name: 'QStash publish token',
        category: 'Scheduled jobs (QStash)',
        message: 'QSTASH_TOKEN configured',
        detail: 'Schedules POST /api/remind, /api/feedback, and delayed /api/qstash/release-hold',
      })
    );
  }

  checks.push(
    result({
      id: 'qstash-url',
      name: 'QStash regional endpoint',
      category: 'Scheduled jobs (QStash)',
      status: qstashUrlFromEnv ? 'healthy' : 'degraded',
      message: qstashUrlFromEnv
        ? `QSTASH_URL = ${qstashUrl}`
        : `QSTASH_URL unset — using ${qstashUrl}`,
      detail:
        'Must match the region of your Upstash QStash token (US: https://qstash-us-east-1.upstash.io). Wrong region → every publish 404s and holds never auto-release.',
    })
  );

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
        message: 'Reminder, feedback, and abandoned-hold release endpoints',
        detail: `${publicBase.replace(/\/$/, '')}/api/remind · ${publicBase.replace(/\/$/, '')}/api/feedback · ${publicBase.replace(/\/$/, '')}/api/qstash/release-hold`,
      })
    );
  }

  return checks;
}

async function checkWebhooks(): Promise<HealthCheckResult[]> {
  const publicBase = (
    process.env.PUBLIC_BASE_URL?.trim() || 'https://www.sadiemarie.co'
  ).replace(/\/$/, '');

  return [
    result({
      id: 'webhook-primary',
      name: 'Primary Cal webhook',
      category: 'Webhooks',
      status: 'healthy',
      message: 'POST /api/webhook — booking lifecycle (SMS, email, DB, QStash)',
      detail: `Configure in Cal.com: ${publicBase}/api/webhook`,
    }),
    result({
      id: 'webhook-idempotency',
      name: 'Webhook deduplication table',
      category: 'Webhooks',
      status: 'healthy',
      message: 'webhook_events table prevents duplicate SMS and emails',
    }),
  ];
}

async function checkCron(): Promise<HealthCheckResult[]> {
  const publicBase = (
    process.env.PUBLIC_BASE_URL?.trim() || 'https://www.sadiemarie.co'
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
      message: `Delayed QStash + checkout timer + cron sweep (${CHECKOUT_HOLD_SECONDS}s hold)`,
      detail: `${publicBase}/api/qstash/release-hold · ${publicBase}/api/booking/release-hold · ${publicBase}/api/cron/cleanup-abandoned`,
    }),
    result({
      id: 'cron-cleanup-abandoned',
      name: 'Abandoned hold safety sweep',
      category: 'Cron jobs',
      status: cronSecret ? 'healthy' : 'degraded',
      message: 'GET /api/cron/cleanup-abandoned — clears stale pending holds if QStash missed them',
      detail: `${publicBase}/api/cron/cleanup-abandoned`,
    }),
    result({
      id: 'cron-sync-reviews',
      name: 'Google reviews sync',
      category: 'Cron jobs',
      status:
        cronSecret && envPresent('GOOGLE_PLACES_API_KEY')
          ? 'healthy'
          : cronSecret
            ? 'degraded'
            : 'degraded',
      message: 'GET /api/cron/sync-reviews — mirrors Google Places reviews to Postgres',
      detail: `${publicBase}/api/cron/sync-reviews`,
    }),
  ];

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

  return [
    result({
      id: 'blob-token',
      name: 'Vercel Blob storage',
      category: 'Storage',
      status: 'healthy',
      message: 'Blob token configured',
      detail: 'Used for consent PDF stamping, client photos, and website CMS images',
    }),
  ];
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
    overall: overallFromSummary(summary),
    checks,
  };
}
