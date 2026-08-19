/**
 * GET /api/cron/health-alert
 *
 * Proactive monitoring: runs the same checks as the admin Health page on a
 * schedule (QStash, every 30 min) and NOTIFIES the owners when something is
 * actually broken — the green banner is only trustworthy if someone looks
 * at it, and nobody stares at a dashboard all day.
 *
 * Alert policy:
 *   • Fires when overall status is `unhealthy` (soft checks — e.g. the
 *     Terminal reader sleeping between appointments — never count).
 *   • Email to the admin allowlist via Resend; SMS to HEALTH_ALERT_PHONE
 *     (optional env, E.164) via Twilio.
 *   • Cooldown via ops_state: the same set of failing checks re-alerts at
 *     most every 6 h; a CHANGED set alerts immediately.
 *   • GET ?simulate=1 (still requires CRON_SECRET) sends a one-shot TEST
 *     email + SMS without changing Health page status or cooldown state.
 *
 * Auth: CRON_SECRET via Bearer / X-Cron-Secret / ?cron_secret=
 * (excluded from the Clerk proxy matcher like the other cron routes).
 */

import { NextRequest, NextResponse } from 'next/server';

import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';
import {
  runHealthChecks,
  type HealthCheckResult,
  type HealthReport,
} from '@/lib/health-check';
import { ALLOWED_ADMIN_EMAILS } from '@/lib/admin-allowlist';
import {
  getOpsState,
  JOB_HEARTBEAT_KEYS,
  recordJobHeartbeat,
  setOpsState,
} from '@/lib/ops-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Re-alert for an unchanged failure set at most this often. */
const REALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ALERT_STATE_KEY = 'health-alert:state';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failing(report: HealthReport): HealthCheckResult[] {
  return report.checks.filter((c) => !c.soft && c.status === 'unhealthy');
}

function degradedList(report: HealthReport): HealthCheckResult[] {
  return report.checks.filter((c) => !c.soft && c.status === 'degraded');
}

function fingerprintOf(checks: HealthCheckResult[]): string {
  return checks
    .map((c) => c.id)
    .sort()
    .join(',');
}

function alertEmailHtml(report: HealthReport): string {
  const bad = failing(report);
  const warn = degradedList(report);
  const row = (c: HealthCheckResult, color: string) =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;"><strong style="color:${color};">${c.status.toUpperCase()}</strong></td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${c.name}<br/><span style="color:#666;font-size:13px;">${c.message}${c.detail ? ` — ${c.detail}` : ''}</span></td>
    </tr>`;
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;">
      <h2 style="margin:0 0 4px;">Sadie Marie — site health alert</h2>
      <p style="margin:0 0 16px;color:#666;">${new Date(report.checkedAt).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain Time)</p>
      <table style="border-collapse:collapse;width:100%;">
        ${bad.map((c) => row(c, '#c62828')).join('')}
        ${warn.map((c) => row(c, '#b26a00')).join('')}
      </table>
      <p style="margin:16px 0 0;color:#666;font-size:13px;">
        Full detail: <a href="https://www.sadiemarie.co/admin/health">admin → Health Check</a>
      </p>
    </div>`;
}

function recoveryEmailHtml(report: HealthReport): string {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;">
      <h2 style="margin:0 0 4px;">Sadie Marie — all clear</h2>
      <p style="margin:0 0 8px;">Every previously failing health check has recovered. Overall status: <strong>${report.overall}</strong>.</p>
      <p style="margin:0;color:#666;font-size:13px;">
        <a href="https://www.sadiemarie.co/admin/health">admin → Health Check</a>
      </p>
    </div>`;
}

async function sendAlertEmail(
  subject: string,
  html: string
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY missing' };
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const from =
      process.env.RESEND_FROM_EMAIL || 'Sadie Marie <bookings@sadiemarie.co>';
    const { error } = await resend.emails.send({
      from,
      to: [...ALLOWED_ADMIN_EMAILS],
      subject,
      html,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function sendAlertSms(body: string): Promise<{
  ok: boolean;
  skipped?: string;
  error?: string;
}> {
  const to = process.env.HEALTH_ALERT_PHONE?.trim();
  if (!to) return { ok: false, skipped: 'HEALTH_ALERT_PHONE not set' };
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!sid || !token || !from) {
    return { ok: false, skipped: 'Twilio not configured' };
  }
  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(sid, token);
    await client.messages.create({ from, to, body });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function isSimulateRequest(req: NextRequest): boolean {
  const raw = req.nextUrl.searchParams.get('simulate')?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

const SIMULATED_FAILURE: HealthCheckResult = {
  id: 'simulate-alert',
  name: 'Simulated health check (test)',
  category: 'Test',
  status: 'unhealthy',
  message: 'Nothing is actually broken — this is a manual test of owner alerts.',
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = rejectUnlessCronAuthorized(req, 'api/cron/health-alert');
  if (gate) return gate;

  const simulate = isSimulateRequest(req);

  let report: HealthReport;
  try {
    report = await runHealthChecks();
  } catch (err) {
    // The monitor itself failing is an alertable event.
    const msg = errorMessage(err);
    console.error('[api/cron/health-alert] runHealthChecks threw', msg);
    await sendAlertEmail(
      'Sadie Marie health monitor error',
      `<p>The scheduled health check itself failed to run: ${msg}</p>`
    );
    return NextResponse.json(
      { error: 'health_check_failed', message: msg },
      { status: 500 }
    );
  }

  const liveOverall = report.overall;

  if (simulate) {
    report = {
      ...report,
      checks: [...report.checks, SIMULATED_FAILURE],
      overall: 'unhealthy',
    };
  }

  const bad = failing(report);
  const fingerprint = fingerprintOf(bad);
  const prior = await getOpsState(ALERT_STATE_KEY);
  const priorFingerprint =
    typeof prior?.value?.fingerprint === 'string'
      ? prior.value.fingerprint
      : '';
  const priorAlertedAt =
    typeof prior?.value?.alertedAt === 'string'
      ? Date.parse(prior.value.alertedAt)
      : NaN;

  let action: 'none' | 'alerted' | 'recovered' | 'cooldown' = 'none';
  let email: { ok: boolean; error?: string } | null = null;
  let sms: { ok: boolean; skipped?: string; error?: string } | null = null;

  if (simulate) {
    // One-shot drill: send the same owner SMS/email path without writing
    // cooldown state, so the next scheduled run does not send an all-clear
    // for a fake outage. The Health page is unchanged.
    action = 'alerted';
    const names = bad.map((c) => c.name).join(', ');
    email = await sendAlertEmail(
      `TEST: Sadie Marie site issue: ${names.slice(0, 110)}`,
      alertEmailHtml(report)
    );
    sms = await sendAlertSms(
      `TEST: Sadie Marie site ALERT: ${names.slice(0, 220)}. Nothing is actually broken. Details: sadiemarie.co/admin/health`
    );
    console.log('[api/cron/health-alert] simulated ALERT sent', {
      failing: bad.map((c) => c.id),
      email,
      sms,
    });
  } else if (bad.length > 0) {
    const sameFailureSet = fingerprint === priorFingerprint;
    const withinCooldown =
      Number.isFinite(priorAlertedAt) &&
      Date.now() - priorAlertedAt < REALERT_COOLDOWN_MS;

    if (sameFailureSet && withinCooldown) {
      action = 'cooldown';
    } else {
      action = 'alerted';
      const names = bad.map((c) => c.name).join(', ');
      email = await sendAlertEmail(
        `🔴 Sadie Marie site issue: ${names.slice(0, 120)}`,
        alertEmailHtml(report)
      );
      sms = await sendAlertSms(
        `Sadie Marie site ALERT: ${names.slice(0, 240)}. Details: sadiemarie.co/admin/health`
      );
      await setOpsState(ALERT_STATE_KEY, {
        fingerprint,
        alertedAt: new Date().toISOString(),
      });
      console.error('[api/cron/health-alert] ALERT sent', {
        failing: bad.map((c) => c.id),
        email,
        sms,
      });
    }
  } else if (priorFingerprint) {
    action = 'recovered';
    email = await sendAlertEmail(
      '🟢 Sadie Marie — site recovered',
      recoveryEmailHtml(report)
    );
    sms = await sendAlertSms(
      'Sadie Marie site RECOVERED — all health checks passing again.'
    );
    await setOpsState(ALERT_STATE_KEY, { fingerprint: '', alertedAt: null });
    console.log('[api/cron/health-alert] recovery notice sent', { email, sms });
  }

  await recordJobHeartbeat(JOB_HEARTBEAT_KEYS.healthAlert, {
    overall: liveOverall,
    failing: simulate ? [] : bad.map((c) => c.id),
    simulated: simulate || undefined,
  });

  return NextResponse.json({
    ok: true,
    simulated: simulate || undefined,
    overall: report.overall,
    failing: bad.map((c) => ({ id: c.id, message: c.message })),
    degraded: degradedList(report).map((c) => c.id),
    action,
    email,
    sms,
  });
}
