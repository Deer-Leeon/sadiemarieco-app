/**
 * GET /api/cron/ensure-reminders
 *
 * Backfill QStash 48h/24h + 1h reminder, day-after feedback, and
 * end+30m Google review-request jobs for confirmed appointments that
 * should receive SMS. Catches admin bookings whose complete/webhook
 * notify never published, QStash publish failures, and confirm retries
 * that skipped scheduling.
 *
 * Auth: CRON_SECRET via Bearer / X-Cron-Secret / ?cron_secret=
 * QStash every 15 minutes; Vercel Cron is the same cadence as a backstop.
 */

import { NextRequest, NextResponse } from 'next/server';

import { rejectUnlessCronAuthorized } from '@/lib/cron-auth';
import { JOB_HEARTBEAT_KEYS, recordJobHeartbeat } from '@/lib/ops-state';
import { ensureUpcomingAppointmentSmsReminders } from '@/lib/booking-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = rejectUnlessCronAuthorized(req, 'api/cron/ensure-reminders');
  if (gate) return gate;

  try {
    const result = await ensureUpcomingAppointmentSmsReminders();
    await recordJobHeartbeat(JOB_HEARTBEAT_KEYS.ensureReminders, {
      scanned: result.scanned,
      scheduled: result.scheduled,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[api/cron/ensure-reminders] failed:', errorMessage(err));
    return NextResponse.json(
      { error: 'ensure_reminders_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
