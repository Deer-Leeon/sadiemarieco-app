/**
 * Same-day cancel and reschedule for the public /manage link.
 * Several services on one studio day move or cancel together. Each service
 * keeps its own 24h / 2h fee. The charge uses the same dedupe key as the
 * Cal webhook so that event cannot charge the service again.
 */

import { sql } from '@vercel/postgres';

import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import { addCalendarDays, studioLocalDateKey } from '@/lib/cal-slot-dates';
import { listStudioAvailableSlots, type BusyInterval } from '@/lib/studio-available-slots';
import { ensureChairDurationSchema } from '@/lib/visit-duration';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

export interface ManageService {
  id: string;
  uid: string | null;
  parent_id: string | null;
  service_name: string;
  start: string;
  end: string;
  day: string;
  duration_mins: number;
  price_cents: number;
}

interface FeeLine {
  id: string;
  service_name: string;
  tier: 'none' | 'late_half' | 'no_show_full';
  fraction: number;
  amount_cents: number;
  amount_display: string;
  waived: boolean;
}

interface ChargeRow {
  id: string;
  status: string | null;
  stripe_customer_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_timing: string | null;
  client_id: string | null;
  client_phone: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  sms_opt_in: boolean | null;
  cal_event_id: string | null;
}

interface ChangeResult {
  status: number;
  json: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listManageServices } = require('./same-day-visit.js') as {
  listManageServices: (uid: string) => Promise<ManageService[]>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lateFees = require('./late-cancel-charge.js') as {
  classifyClientCancelPenalty: (
    bookingTime: string
  ) => 'none' | 'late_half' | 'no_show_full';
  penaltyAmountCents: (price: number, fraction: number) => number;
  LATE_CANCEL_FRACTION: number;
  NO_SHOW_CANCEL_FRACTION: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webhookHandler = require('./legacy-handlers/webhook.js') as {
  applyClientChangePenaltyFee: (args: {
    existing: Record<string, unknown>;
    dedupeKey: string;
    action: 'cancel' | 'reschedule';
    logPrefix: string;
  }) => Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const notifications = require('./booking-notifications.js') as {
  claimSkipClientSms: (uid: string) => Promise<unknown>;
  releaseSkipClientSms: (uid: string) => Promise<unknown>;
  notifyAppointmentRescheduled: (args: Record<string, unknown>) => Promise<unknown>;
  rescheduleAppointmentReminderEmails: (uid: string) => Promise<unknown>;
};

function money(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '$0';
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function parseIds(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((value) => String(value))
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const ids = parts.map((value) => value.trim()).filter((value) => UUID_RE.test(value));
  return [...new Set(ids)];
}

function endIsoFromMinutes(startIso: string, mins: number): string {
  return new Date(new Date(startIso).getTime() + mins * 60_000).toISOString();
}

function sameMinute(a: string, b: string): boolean {
  const am = new Date(a).getTime();
  const bm = new Date(b).getTime();
  return Number.isFinite(am) && Number.isFinite(bm) && Math.abs(am - bm) < 60_000;
}

function byStart(a: ManageService, b: ManageService): number {
  return a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

function visitKey(service: ManageService): string {
  return service.parent_id || service.id;
}

function selectionPlan(all: ManageService[], selected: ManageService[]) {
  const selectedIds = new Set(selected.map((service) => service.id));
  const exclude = new Set<string>();
  for (const service of selected) exclude.add(visitKey(service));

  const extraBusy: BusyInterval[] = [];
  const visits = new Map<string, ManageService[]>();
  for (const service of all) {
    const key = visitKey(service);
    if (!exclude.has(key)) continue;
    const list = visits.get(key) || [];
    list.push(service);
    visits.set(key, list);
  }

  for (const members of visits.values()) {
    const staying = members.filter((service) => !selectedIds.has(service.id));
    if (staying.length === 0) continue;
    const mins = staying.reduce((sum, service) => sum + service.duration_mins, 0);
    const startMs = Math.min(
      ...members.map((service) => new Date(service.start).getTime())
    );
    if (mins > 0 && Number.isFinite(startMs)) {
      extraBusy.push({ startMs, endMs: startMs + mins * 60_000 });
    }
  }

  return {
    excludeIds: [...exclude],
    extraBusy,
    durationMins: selected.reduce((sum, service) => sum + service.duration_mins, 0),
  };
}

async function loadOwned(uid: string): Promise<ManageService[]> {
  const services = await listManageServices(uid);
  return Array.isArray(services) ? services : [];
}

function pickSelected(all: ManageService[], ids: string[]): ManageService[] | null {
  const byId = new Map(all.map((service) => [service.id, service]));
  const selected: ManageService[] = [];
  for (const id of ids) {
    const service = byId.get(id);
    if (!service) return null;
    selected.push(service);
  }
  return selected;
}

function selectionError(selected: ManageService[]): ChangeResult | null {
  if (selected.length === 0) {
    return {
      status: 400,
      json: { ok: false, error: 'missing_services', message: 'Choose at least one service.' },
    };
  }
  const day = selected[0].day;
  if (selected.some((service) => service.day !== day)) {
    return {
      status: 400,
      json: {
        ok: false,
        error: 'mixed_days',
        message: 'Choose services from the same day.',
      },
    };
  }
  if (selected.some((service) => new Date(service.start).getTime() <= Date.now())) {
    return {
      status: 409,
      json: {
        ok: false,
        error: 'appointment_started',
        message:
          'One of these services has already started and can no longer be changed.',
      },
    };
  }
  return null;
}

async function loadClientId(serviceId: string): Promise<string | null> {
  const { rows } = await sql<{ client_id: string | null }>`
    SELECT client_id::text AS client_id
    FROM appointments
    WHERE id::text = ${serviceId}
    LIMIT 1
  `;
  return rows[0]?.client_id ?? null;
}

async function loadWaive(clientId: string | null): Promise<{ late: boolean; noShow: boolean }> {
  if (!clientId) return { late: false, noShow: false };
  const { rows } = await sql<{
    late_change_waive_next: boolean | null;
    no_show_waive_next: boolean | null;
  }>`
    SELECT late_change_waive_next, no_show_waive_next
    FROM clients
    WHERE id = ${clientId}::uuid
    LIMIT 1
  `;
  return {
    late: rows[0]?.late_change_waive_next === true,
    noShow: rows[0]?.no_show_waive_next === true,
  };
}

async function previewFees(selected: ManageService[], clientId: string | null) {
  const waive = await loadWaive(clientId);
  let lateUsed = false;
  let noShowUsed = false;
  const services: FeeLine[] = [...selected].sort(byStart).map((service) => {
    const tier = lateFees.classifyClientCancelPenalty(service.start);
    if (tier === 'none') {
      return {
        id: service.id,
        service_name: service.service_name,
        tier,
        fraction: 0,
        amount_cents: 0,
        amount_display: '$0',
        waived: false,
      };
    }
    const fraction =
      tier === 'no_show_full'
        ? lateFees.NO_SHOW_CANCEL_FRACTION
        : lateFees.LATE_CANCEL_FRACTION;
    let waived = false;
    if (tier === 'no_show_full' && waive.noShow && !noShowUsed) {
      waived = true;
      noShowUsed = true;
    } else if (tier === 'late_half' && waive.late && !lateUsed) {
      waived = true;
      lateUsed = true;
    }
    const amountCents = waived
      ? 0
      : lateFees.penaltyAmountCents(service.price_cents / 100, fraction);
    return {
      id: service.id,
      service_name: service.service_name,
      tier,
      fraction,
      amount_cents: amountCents,
      amount_display: money(amountCents),
      waived,
    };
  });
  const totalCents = services.reduce((sum, service) => sum + service.amount_cents, 0);
  return {
    services,
    total_cents: totalCents,
    total_display: money(totalCents),
    duration_mins: selected.reduce((sum, service) => sum + service.duration_mins, 0),
  };
}

async function chargeSelected(
  selected: ManageService[],
  action: 'cancel' | 'reschedule'
): Promise<Map<string, { penalty_kind?: string } | null>> {
  const ids = selected.map((service) => service.id);
  const { rows } = await sql.query<ChargeRow>(
    `SELECT
       id::text AS id,
       status,
       stripe_customer_id,
       stripe_payment_intent_id,
       payment_timing,
       client_id::text AS client_id,
       client_phone,
       client_first_name,
       client_last_name,
       sms_opt_in,
       NULLIF(TRIM(cal_event_id), '') AS cal_event_id
     FROM appointments
     WHERE id::text = ANY($1::text[])`,
    [ids]
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const charged = new Map<string, { penalty_kind?: string } | null>();
  for (const service of [...selected].sort(byStart)) {
    const row = byId.get(service.id);
    if (!row) continue;
    const uid = row.cal_event_id ? String(row.cal_event_id).trim() : '';
    const suffix = action === 'cancel' ? 'cancel_fee' : 'change_fee';
    const result = await webhookHandler.applyClientChangePenaltyFee({
      existing: {
        id: row.id,
        status: row.status,
        booking_time: service.start,
        service_name: service.service_name,
        service_price: service.price_cents / 100,
        stripe_customer_id: row.stripe_customer_id,
        stripe_payment_intent_id: row.stripe_payment_intent_id,
        payment_timing: row.payment_timing,
        client_id: row.client_id,
        client_phone: row.client_phone,
        sms_opt_in: row.sms_opt_in,
        cal_event_id: uid || null,
      },
      dedupeKey: uid ? `${uid}:${suffix}` : `extra:${service.id}:${suffix}`,
      action,
      logPrefix: '[api/manage/change]',
    });
    charged.set(service.id, (result as { penalty_kind?: string } | null) ?? null);
  }
  return charged;
}

async function writeBlock(members: ManageService[], startIso: string): Promise<ManageService> {
  const mins = members.reduce((sum, service) => sum + service.duration_mins, 0);
  const endIso = endIsoFromMinutes(startIso, mins);
  const keeper = members.find((service) => service.uid) || members[0];
  const label =
    members
      .map((service) => service.service_name)
      .filter(Boolean)
      .join(' + ') || 'Appointment';

  await sql`
    UPDATE appointments
    SET booking_time = ${startIso},
        end_time = ${endIso},
        chair_duration_mins = ${mins},
        attached_to_appointment_id = NULL,
        status = 'confirmed'
    WHERE id::text = ${keeper.id}
  `;

  for (const member of members) {
    if (member.id === keeper.id) continue;
    await sql`
      UPDATE appointments
      SET booking_time = ${startIso},
          end_time = ${endIso},
          chair_duration_mins = NULL,
          attached_to_appointment_id = ${keeper.id}::uuid,
          status = 'confirmed'
      WHERE id::text = ${member.id}
    `;
  }

  return { ...keeper, start: startIso, end: endIso, service_name: label, duration_mins: mins };
}

async function parkStaying(all: ManageService[], selected: ManageService[]): Promise<void> {
  const selectedIds = new Set(selected.map((service) => service.id));
  const visits = new Map<string, ManageService[]>();
  for (const service of all) {
    const key = visitKey(service);
    const list = visits.get(key) || [];
    list.push(service);
    visits.set(key, list);
  }

  for (const members of visits.values()) {
    const staying = members.filter((service) => !selectedIds.has(service.id));
    const moving = members.some((service) => selectedIds.has(service.id));
    if (!moving || staying.length === 0) continue;
    const startMs = Math.min(...members.map((service) => new Date(service.start).getTime()));
    await writeBlock(staying, new Date(startMs).toISOString());
  }
}

async function snapshotRows(ids: string[]) {
  const { rows } = await sql.query<{
    id: string;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    chair_duration_mins: number | null;
    attached_to_appointment_id: string | null;
    cal_event_id: string | null;
    status: string | null;
  }>(
    `SELECT
       id::text AS id,
       booking_time,
       end_time,
       chair_duration_mins,
       attached_to_appointment_id::text AS attached_to_appointment_id,
       cal_event_id,
       status
     FROM appointments
     WHERE id::text = ANY($1::text[])`,
    [ids]
  );
  return rows;
}

async function restoreRows(
  rows: Array<{
    id: string;
    booking_time: Date | string | null;
    end_time: Date | string | null;
    chair_duration_mins: number | null;
    attached_to_appointment_id: string | null;
    cal_event_id: string | null;
    status: string | null;
  }>
) {
  for (const row of rows) {
    const start = row.booking_time ? new Date(row.booking_time).toISOString() : null;
    const end = row.end_time ? new Date(row.end_time).toISOString() : null;
    if (row.attached_to_appointment_id) {
      await sql`
        UPDATE appointments
        SET booking_time = ${start},
            end_time = ${end},
            chair_duration_mins = ${row.chair_duration_mins},
            attached_to_appointment_id = ${row.attached_to_appointment_id}::uuid,
            cal_event_id = ${row.cal_event_id},
            status = ${row.status}
        WHERE id::text = ${row.id}
      `;
    } else {
      await sql`
        UPDATE appointments
        SET booking_time = ${start},
            end_time = ${end},
            chair_duration_mins = ${row.chair_duration_mins},
            attached_to_appointment_id = NULL,
            cal_event_id = ${row.cal_event_id},
            status = ${row.status}
        WHERE id::text = ${row.id}
      `;
    }
  }
}

async function calPost(path: string, body: Record<string, unknown>) {
  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) return { ok: false as const, payload: null };
  const upstream = await fetch(`${CAL_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'cal-api-version': CAL_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = (await upstream.json().catch(() => null)) as {
    data?: { uid?: string };
    uid?: string;
  } | null;
  return { ok: upstream.ok, payload };
}

async function openSlots(all: ManageService[], selected: ManageService[]) {
  const plan = selectionPlan(all, selected);
  const today = studioLocalDateKey(new Date().toISOString());
  const listed = await listStudioAvailableSlots({
    rangeStartYmd: today,
    rangeEndYmd: addCalendarDays(today, 42),
    durationMins: plan.durationMins,
    excludeAppointmentIds: plan.excludeIds,
    extraBusy: plan.extraBusy,
  });
  if (!listed.ok) {
    return { ok: false as const, message: listed.message, plan, today, slots: {} };
  }
  const slots: Record<string, string[]> = {};
  for (const [day, times] of Object.entries(listed.slots)) {
    const open = times.filter((iso) => !selected.every((service) => sameMinute(service.start, iso)));
    if (open.length > 0) slots[day] = open;
  }
  return { ok: true as const, slots, plan, today };
}

async function resolveSelection(uid: string, ids: string[]) {
  if (!uid || uid.length > 128) {
    return {
      error: {
        status: 400,
        json: { ok: false, error: 'missing_uid', message: 'This manage link is missing its booking.' },
      } satisfies ChangeResult,
    };
  }
  if (ids.length === 0) {
    return {
      error: {
        status: 400,
        json: { ok: false, error: 'missing_services', message: 'Choose at least one service.' },
      } satisfies ChangeResult,
    };
  }
  const all = await loadOwned(uid);
  const selected = pickSelected(all, ids);
  if (!selected) {
    return {
      error: {
        status: 403,
        json: {
          ok: false,
          error: 'not_your_visit',
          message: 'Those services are not on this manage link.',
        },
      } satisfies ChangeResult,
    };
  }
  const invalid = selectionError(selected);
  if (invalid) return { error: invalid };
  return { all, selected };
}

export async function handleManageChange(
  method: 'GET' | 'POST',
  query: Record<string, string | undefined>,
  body: Record<string, unknown> | null
): Promise<ChangeResult> {
  try {
    if (method === 'GET') {
      const uid = (query.uid || '').trim();
      const resolved = await resolveSelection(uid, parseIds(query.ids));
      if ('error' in resolved && resolved.error) return resolved.error;
      const { all, selected } = resolved as { all: ManageService[]; selected: ManageService[] };
      const opened = await openSlots(all, selected);
      if (!opened.ok) {
        return { status: 502, json: { ok: false, error: 'slots_unavailable', message: opened.message } };
      }
      return {
        status: 200,
        json: {
          ok: true,
          slots: opened.slots,
          today: opened.today,
          duration_mins: opened.plan.durationMins,
        },
      };
    }

    const uid = typeof body?.uid === 'string' ? body.uid.trim() : '';
    const action = typeof body?.action === 'string' ? body.action : '';
    const resolved = await resolveSelection(uid, parseIds(body?.ids));
    if ('error' in resolved && resolved.error) return resolved.error;
    const { all, selected } = resolved as { all: ManageService[]; selected: ManageService[] };
    const clientId = await loadClientId(selected[0].id);

    if (action === 'preview') {
      const fees = await previewFees(selected, clientId);
      return { status: 200, json: { ok: true, ...fees } };
    }

    if (action === 'cancel') {
      await ensureChairDurationSchema();
      await ensureAppointmentAttachedSchema();
      const charged = await chargeSelected(selected, 'cancel');
      await parkStaying(all, selected);
      const cancelUids: string[] = [];
      for (const service of selected) {
        if (service.uid) cancelUids.push(service.uid);
        const penalty = charged.get(service.id)?.penalty_kind;
        const status =
          penalty === 'no_show_full'
            ? 'no-show'
            : penalty === 'late_half'
              ? 'canceled_by_client_late'
              : 'canceled_by_client';
        if (penalty === 'no_show_full') {
          await sql`
            UPDATE appointments
            SET status = ${status},
                no_show_strike = FALSE,
                attached_to_appointment_id = NULL
            WHERE id::text = ${service.id}
          `;
        } else {
          await sql`
            UPDATE appointments
            SET status = ${status},
                attached_to_appointment_id = NULL
            WHERE id::text = ${service.id}
          `;
        }
      }
      for (const calUid of cancelUids) {
        const cancelled = await calPost(
          `/bookings/${encodeURIComponent(calUid)}/cancel`,
          { cancellationReason: 'Cancelled by client via management portal' }
        );
        if (!cancelled.ok) {
          console.warn('[api/manage/change] cal cancel failed', { calUid });
        }
      }
      const remaining = await loadOwned(uid);
      const next = remaining.find((service) => service.uid);
      return {
        status: 200,
        json: {
          ok: true,
          remaining: remaining.length,
          remaining_uid: next?.uid || null,
        },
      };
    }

    if (action === 'reschedule') {
      const startIso = typeof body?.start === 'string' ? body.start.trim() : '';
      if (!startIso || !Number.isFinite(Date.parse(startIso))) {
        return {
          status: 400,
          json: { ok: false, error: 'missing_start', message: 'Choose a new time.' },
        };
      }
      if (selected.every((service) => sameMinute(service.start, startIso))) {
        return {
          status: 409,
          json: {
            ok: false,
            error: 'same_slot',
            message: "You're already booked for this time. Pick a different time.",
          },
        };
      }
      const opened = await openSlots(all, selected);
      if (!opened.ok) {
        return { status: 502, json: { ok: false, error: 'slots_unavailable', message: opened.message } };
      }
      const fits = Object.values(opened.slots)
        .flat()
        .some((iso) => sameMinute(iso, startIso));
      if (!fits) {
        return {
          status: 409,
          json: {
            ok: false,
            error: 'slot_unavailable',
            message: 'That time is no longer long enough. Please pick another.',
          },
        };
      }

      await ensureChairDurationSchema();
      await ensureAppointmentAttachedSchema();
      const touched = new Set(selected.map((service) => service.id));
      for (const service of all) {
        if (selected.some((chosen) => visitKey(chosen) === visitKey(service))) {
          touched.add(service.id);
        }
      }
      const before = await snapshotRows([...touched]);
      await chargeSelected(selected, 'reschedule');
      await parkStaying(all, selected);

      const keeper = selected.find((service) => service.uid) || selected[0];
      const retireUids = selected
        .filter((service) => service.uid && service.id !== keeper.id)
        .map((service) => service.uid as string);
      for (const service of selected) {
        if (service.id === keeper.id || !service.uid) continue;
        await sql`
          UPDATE appointments
          SET cal_event_id = NULL
          WHERE id::text = ${service.id}
        `;
      }

      const block = await writeBlock(selected, new Date(startIso).toISOString());
      let manageUid = keeper.uid;
      if (keeper.uid) {
        try {
          await notifications.claimSkipClientSms(keeper.uid);
        } catch (err) {
          console.warn('[api/manage/change] skip-sms claim failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const moved = await calPost(
          `/bookings/${encodeURIComponent(keeper.uid)}/reschedule`,
          {
            start: block.start,
            reschedulingReason: 'Client moved this visit',
          }
        );
        if (!moved.ok) {
          console.warn('[api/manage/change] cal reschedule failed', { uid: keeper.uid });
          try {
            await notifications.releaseSkipClientSms(keeper.uid);
          } catch {
            /* no webhook is coming */
          }
          await restoreRows(before);
          return {
            status: 502,
            json: {
              ok: false,
              error: 'calendar_move_failed',
              message:
                "We couldn't move that time. Please try again, or contact the studio if you see a fee.",
            },
          };
        }
        const data = moved.payload?.data || moved.payload;
        const newUid = data && typeof data.uid === 'string' ? data.uid : keeper.uid;
        if (newUid && newUid !== keeper.uid) {
          await sql`
            UPDATE appointments
            SET cal_event_id = ${newUid}
            WHERE id::text = ${keeper.id}
              AND cal_event_id = ${keeper.uid}
          `;
          manageUid = newUid;
        }
        try {
          const { rows } = await sql<{
            client_phone: string | null;
            sms_opt_in: boolean | null;
            client_first_name: string | null;
            client_last_name: string | null;
          }>`
            SELECT client_phone, sms_opt_in, client_first_name, client_last_name
            FROM appointments
            WHERE id::text = ${keeper.id}
            LIMIT 1
          `;
          const row = rows[0];
          const clientName = [row?.client_first_name, row?.client_last_name]
            .filter(Boolean)
            .join(' ');
          await notifications.notifyAppointmentRescheduled({
            bookingUid: manageUid,
            bookingTime: block.start,
            endTime: block.end,
            clientPhone: row?.client_phone || '',
            serviceName: block.service_name,
            smsOptIn: row?.sms_opt_in === true,
            source: 'client',
            clientName,
            appointmentId: keeper.id,
            sendClientSms: true,
          });
          if (manageUid) {
            await notifications.rescheduleAppointmentReminderEmails(manageUid);
          }
        } catch (err) {
          console.warn('[api/manage/change] reschedule notice failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      for (const calUid of retireUids) {
        const cancelled = await calPost(`/bookings/${encodeURIComponent(calUid)}/cancel`, {
          cancellationReason: 'Rescheduled into one visit',
        });
        if (!cancelled.ok) {
          console.warn('[api/manage/change] cal retire failed', { calUid });
        }
      }

      return {
        status: 200,
        json: {
          ok: true,
          uid: manageUid,
          start: block.start,
          end: block.end,
          service_name: block.service_name,
          duration_mins: block.duration_mins,
        },
      };
    }

    return {
      status: 400,
      json: { ok: false, error: 'unknown_action', message: 'Choose cancel or reschedule.' },
    };
  } catch (err) {
    console.error('[api/manage/change] failed', err);
    return {
      status: 500,
      json: {
        ok: false,
        error: 'change_failed',
        message: "We couldn't update that visit. Please try again or contact the studio.",
      },
    };
  }
}
