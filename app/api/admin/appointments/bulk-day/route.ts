/**
 * POST /api/admin/appointments/bulk-day
 *
 * Cancel or reschedule several of one client's services on the same studio
 * day. Reschedule stacks them back to back from one start, earliest first.
 * One text names those services. Client late fees are not charged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import {
  claimSkipClientSms,
  notifyAdminAppointmentStatusSms,
  notifyAppointmentRescheduled,
  notifyBulkDayChange,
  rescheduleAppointmentReminderEmails,
} from '@/lib/booking-notifications';
import {
  CAL_STUDIO_IN_PERSON_LOCATION,
  getCalComApiKey,
  loadServiceByCalEventId,
  parseAdminOverrideEventId,
  STUDIO_TIMEZONE,
} from '@/lib/cal-config';
import { studioLocalDateKey } from '@/lib/cal-slot-dates';
import { parseBookingStartForCal, CalStartTimeError } from '@/lib/cal-timezone';
import {
  CAL_BOOKINGS_ADMIN_CREATE_API_VERSION,
  CAL_BOOKINGS_API_VERSION,
  CAL_V2_BASE,
  confirmCalV2Booking,
  proxyCalV2Post,
} from '@/lib/cal-proxy';
import {
  calAttendeeEmailForBooking,
  parseClientPhone,
  parseOptionalClientEmail,
} from '@/lib/client-identity';
import { markAdminRescheduleIntent } from '@/lib/admin-reschedule-intent';
import { parseSendSmsFromBody } from '@/lib/admin-send-sms-flag';
import { ensureChairDurationSchema } from '@/lib/visit-duration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_CANCEL_REASON = 'Canceled by admin';

interface VisitRow {
  id: string;
  cal_event_id: string | null;
  parent_id: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  chair_duration_mins: number | null;
  cal_event_type_id: number | null;
  service_name: string | null;
  status: string | null;
  client_id: string | null;
  client_phone: string | null;
  client_email: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  sms_opt_in: boolean | null;
  payment_timing: string | null;
  stripe_payment_intent_id: string | null;
  duration_mins: number | null;
}

interface PlannedVisit extends VisitRow {
  durationMins: number;
  startIso: string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { joinThen } = require('@/lib/sms-appointment-copy.js') as {
  joinThen: (parts: string[]) => string;
};

// formatStudioTime is not exported. Format here.
function studioTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: STUDIO_TIMEZONE,
  }).format(date);
}

function serviceTitle(name: string | null): string {
  const cleaned = (name || 'appointment').replace(/\s+between\s+.+$/i, '').trim();
  return cleaned || 'appointment';
}

function isoOf(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function phoneDigits(raw: string | null): string {
  return (raw || '').replace(/\D/g, '');
}

function sameClient(a: VisitRow, b: VisitRow): boolean {
  if (a.client_id && b.client_id && a.client_id === b.client_id) return true;
  const left = phoneDigits(a.client_phone);
  const right = phoneDigits(b.client_phone);
  if (left && right && (left === right || left.endsWith(right) || right.endsWith(left))) {
    return true;
  }
  const emailA = (a.client_email || '').trim().toLowerCase();
  const emailB = (b.client_email || '').trim().toLowerCase();
  return Boolean(emailA && emailA === emailB);
}

function ownDuration(row: VisitRow, extras: VisitRow[]): number {
  const catalogue = Number(row.duration_mins);
  if (Number.isFinite(catalogue) && catalogue > 0) return catalogue;
  const extraMins = extras.reduce((sum, extra) => {
    const mins = Number(extra.duration_mins);
    return sum + (Number.isFinite(mins) && mins > 0 ? mins : 0);
  }, 0);
  const chair = Number(row.chair_duration_mins);
  if (Number.isFinite(chair) && chair > extraMins) return chair - extraMins;
  const start = isoOf(row.booking_time);
  const end = isoOf(row.end_time);
  if (start && end && extras.length === 0) {
    const span = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
    if (span > 0) return span;
  }
  return 30;
}

function byStart(a: VisitRow, b: VisitRow): number {
  const at = isoOf(a.booking_time) || '';
  const bt = isoOf(b.booking_time) || '';
  return at.localeCompare(bt) || a.id.localeCompare(b.id);
}

async function loadRows(ids: string[]): Promise<VisitRow[]> {
  const { rows } = await sql.query<VisitRow>(
    `SELECT
       a.id::text AS id,
       NULLIF(TRIM(a.cal_event_id), '') AS cal_event_id,
       a.attached_to_appointment_id::text AS parent_id,
       a.booking_time,
       a.end_time,
       a.chair_duration_mins,
       a.cal_event_type_id,
       a.service_name,
       a.status,
       a.client_id::text AS client_id,
       a.client_phone,
       a.client_email,
       a.client_first_name,
       a.client_last_name,
       a.sms_opt_in,
       a.payment_timing,
       a.stripe_payment_intent_id,
       s.duration_mins
     FROM appointments a
     LEFT JOIN LATERAL (
       SELECT duration_mins
       FROM site_services s
       WHERE s.is_active = TRUE
         AND s.is_group = FALSE
         AND a.cal_event_type_id IS NOT NULL
         AND s.cal_event_id = a.cal_event_type_id
       ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
       LIMIT 1
     ) s ON TRUE
     WHERE a.id::text = ANY($1::text[])`,
    [ids]
  );
  return rows;
}

async function loadDayRows(anchor: VisitRow, day: string): Promise<VisitRow[]> {
  const digits = phoneDigits(anchor.client_phone);
  const clientId = anchor.client_id;
  const { rows } = await sql.query<VisitRow>(
    `SELECT
       a.id::text AS id,
       NULLIF(TRIM(a.cal_event_id), '') AS cal_event_id,
       a.attached_to_appointment_id::text AS parent_id,
       a.booking_time,
       a.end_time,
       a.chair_duration_mins,
       a.cal_event_type_id,
       a.service_name,
       a.status,
       a.client_id::text AS client_id,
       a.client_phone,
       a.client_email,
       a.client_first_name,
       a.client_last_name,
       a.sms_opt_in,
       a.payment_timing,
       a.stripe_payment_intent_id,
       s.duration_mins
     FROM appointments a
     LEFT JOIN LATERAL (
       SELECT duration_mins
       FROM site_services s
       WHERE s.is_active = TRUE
         AND s.is_group = FALSE
         AND a.cal_event_type_id IS NOT NULL
         AND s.cal_event_id = a.cal_event_type_id
       ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
       LIMIT 1
     ) s ON TRUE
     WHERE LOWER(COALESCE(a.status, '')) = 'confirmed'
       AND a.booking_time IS NOT NULL
       AND to_char(a.booking_time AT TIME ZONE 'America/Denver', 'YYYY-MM-DD') = $1
       AND (
         ($2::text IS NOT NULL AND a.client_id::text = $2)
         OR (
           $3 <> ''
           AND regexp_replace(COALESCE(a.client_phone, ''), '\\D', '', 'g') <> ''
           AND (
             regexp_replace(a.client_phone, '\\D', '', 'g') = $3
             OR regexp_replace(a.client_phone, '\\D', '', 'g') = $4
             OR regexp_replace(a.client_phone, '\\D', '', 'g') = $5
           )
         )
       )`,
    [
      day,
      clientId,
      digits,
      digits.length === 10 ? `1${digits}` : '',
      digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : '',
    ]
  );
  return rows;
}

async function writeWindow(
  id: string,
  startIso: string,
  endIso: string,
  durationMins: number,
  status: string
) {
  await sql`
    UPDATE appointments
    SET booking_time = ${startIso},
        end_time = ${endIso},
        chair_duration_mins = ${durationMins},
        attached_to_appointment_id = NULL,
        status = ${status}
    WHERE id::text = ${id}
  `;
}

async function cancelOnCal(uid: string, reason: string): Promise<string | null> {
  const apiKey = getCalComApiKey();
  if (!apiKey) return 'Cal.com API key is not configured';
  try {
    const upstream = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(uid)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'cal-api-version': CAL_BOOKINGS_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ cancellationReason: reason }),
      }
    );
    if (upstream.status === 404) return null;
    if (!upstream.ok) {
      const payload = (await upstream.json().catch(() => null)) as { message?: string } | null;
      return payload?.message || `HTTP ${upstream.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function extractUid(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const booking =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  return typeof booking.uid === 'string' && booking.uid ? booking.uid : null;
}

async function createCalBooking(args: {
  eventTypeId: number;
  startIso: string;
  durationMins: number;
  row: VisitRow;
}): Promise<{ ok: true; uid: string } | { ok: false; message: string }> {
  const service = await loadServiceByCalEventId(args.eventTypeId);
  const duration = service?.duration_mins || args.durationMins;
  const parsedPhone = parseClientPhone(args.row.client_phone);
  if (!parsedPhone) {
    return { ok: false, message: 'This client needs a valid phone before the calendar can move.' };
  }
  const firstName = (args.row.client_first_name || '').trim() || 'Client';
  const lastName = (args.row.client_last_name || '').trim() || 'Guest';
  const clientName = [firstName, lastName].filter(Boolean).join(' ');
  const clientEmail = parseOptionalClientEmail(args.row.client_email);
  const overrideEventTypeId = parseAdminOverrideEventId();
  const calPayload: Record<string, unknown> = {
    eventTypeId: args.eventTypeId,
    start: args.startIso,
    attendee: {
      name: clientName,
      email: calAttendeeEmailForBooking(parsedPhone.digits, clientEmail),
      phoneNumber: parsedPhone.e164,
      timeZone: STUDIO_TIMEZONE,
    },
    bookingFieldsResponses: {
      name: { firstName, lastName },
      attendeePhoneNumber: parsedPhone.e164,
    },
    location: {
      type: CAL_STUDIO_IN_PERSON_LOCATION.type,
      address: CAL_STUDIO_IN_PERSON_LOCATION.address,
    },
    metadata: {
      manual_admin_booking: 'true',
      admin_reschedule: 'true',
      original_service_name: service?.title || serviceTitle(args.row.service_name),
      original_cal_event_id: String(args.eventTypeId),
      original_service_duration_mins: String(duration),
    },
  };
  if (overrideEventTypeId != null) {
    calPayload.allowConflicts = true;
    calPayload.allowBookingOutOfBounds = true;
  }
  let result = await proxyCalV2Post(
    '/bookings',
    calPayload,
    overrideEventTypeId != null
      ? CAL_BOOKINGS_ADMIN_CREATE_API_VERSION
      : CAL_BOOKINGS_API_VERSION
  );
  if (!result.ok && overrideEventTypeId != null) {
    const shadow: Record<string, unknown> = {
      ...calPayload,
      eventTypeId: overrideEventTypeId,
      lengthInMinutes: duration,
    };
    delete shadow.allowConflicts;
    delete shadow.allowBookingOutOfBounds;
    result = await proxyCalV2Post('/bookings', shadow, CAL_BOOKINGS_API_VERSION);
  }
  if (!result.ok) {
    const payload = await result.response.json().catch(() => null);
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : 'Calendar could not create the new time.';
    return { ok: false, message };
  }
  const uid = extractUid(result.data);
  if (!uid) return { ok: false, message: 'Calendar did not return a booking.' };
  const created = result.data as { data?: { status?: string }; status?: string };
  const status = created.data?.status || created.status;
  if (status && status.toUpperCase() !== 'ACCEPTED') {
    await confirmCalV2Booking(uid);
  }
  return { ok: true, uid };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prepaid = require('@/lib/prepaid-booking-refund.js') as {
  isPrepaidPayNowAppointment: (row: object) => boolean;
  refundPrepaidBooking: (args: {
    paymentIntentId: string;
    keepFraction: number;
    appointmentId?: string;
    calBookingUid?: string | null;
    reason?: string;
    feeType?: string;
  }) => Promise<{ ok: boolean }>;
};

export async function POST(req: NextRequest) {
  const access = await requireAdminUser();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.reason },
      { status: access.reason === 'unauthenticated' ? 401 : 403 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    ids?: unknown;
    start?: unknown;
    send_sms?: unknown;
    sendSms?: unknown;
  } | null;
  const action = body?.action === 'cancel' || body?.action === 'reschedule' ? body.action : null;
  const ids = Array.isArray(body?.ids)
    ? [...new Set(body.ids.map((id) => String(id).trim()).filter((id) => UUID_RE.test(id)))]
    : [];
  if (!action || ids.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'invalid_body', message: 'Choose at least one service.' },
      { status: 400 }
    );
  }
  const sendSms = parseSendSmsFromBody(body);

  try {
    await ensureChairDurationSchema();
    await ensureAppointmentAttachedSchema();
    const selectedRows = await loadRows(ids);
    if (selectedRows.length !== ids.length) {
      return NextResponse.json(
        { ok: false, error: 'not_found', message: 'One of those services is no longer on the calendar.' },
        { status: 404 }
      );
    }
    const anchor = selectedRows[0];
    if (!anchor) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    if (selectedRows.some((row) => !sameClient(anchor, row))) {
      return NextResponse.json(
        { ok: false, error: 'mixed_clients', message: 'Choose services for one client.' },
        { status: 400 }
      );
    }
    const anchorStart = isoOf(anchor.booking_time);
    const day = anchorStart ? studioLocalDateKey(anchorStart) : '';
    if (!day || selectedRows.some((row) => studioLocalDateKey(isoOf(row.booking_time) || '') !== day)) {
      return NextResponse.json(
        { ok: false, error: 'mixed_days', message: 'Choose services from the same day.' },
        { status: 400 }
      );
    }
    if (
      selectedRows.some((row) => {
        const status = (row.status || '').toLowerCase();
        return status.startsWith('canceled') || status === 'cancelled' || status === 'no-show';
      })
    ) {
      return NextResponse.json(
        { ok: false, error: 'not_active', message: 'One of those services is already closed.' },
        { status: 409 }
      );
    }

    const dayRows = await loadDayRows(anchor, day);
    const byId = new Map<string, VisitRow>();
    for (const row of [...dayRows, ...selectedRows]) byId.set(row.id, row);
    const extrasByParent = new Map<string, VisitRow[]>();
    for (const row of byId.values()) {
      if (!row.parent_id) continue;
      const list = extrasByParent.get(row.parent_id) || [];
      list.push(row);
      extrasByParent.set(row.parent_id, list);
    }
    const withDuration = (row: VisitRow) => ({
      ...row,
      durationMins: ownDuration(row, row.parent_id ? [] : extrasByParent.get(row.id) || []),
    });

    const ordered = selectedRows.map((row) => withDuration(byId.get(row.id) || row)).sort(byStart);
    const selectedIds = new Set(ordered.map((row) => row.id));

    if (action === 'cancel') {
      const groups = new Map<string, VisitRow[]>();
      for (const row of byId.values()) {
        const key = row.parent_id || row.id;
        const list = groups.get(key) || [];
        list.push(row);
        groups.set(key, list);
      }
      for (const members of groups.values()) {
        const staying = members.filter((row) => !selectedIds.has(row.id)).map(withDuration).sort(byStart);
        const moving = members.some((row) => selectedIds.has(row.id));
        if (!moving || staying.length === 0) continue;
        const origin = Math.min(
          ...members.map((row) => new Date(isoOf(row.booking_time) || 0).getTime())
        );
        let cursor = origin;
        for (const row of staying) {
          const startIso = new Date(cursor).toISOString();
          const endIso = new Date(cursor + row.durationMins * 60_000).toISOString();
          cursor += row.durationMins * 60_000;
          await writeWindow(row.id, startIso, endIso, row.durationMins, 'confirmed');
        }
      }

      const calErrors: string[] = [];
      for (const row of ordered) {
        if (row.cal_event_id) {
          const error = await cancelOnCal(row.cal_event_id, ADMIN_CANCEL_REASON);
          if (error) calErrors.push(error);
        }
        if (prepaid.isPrepaidPayNowAppointment(row) && row.stripe_payment_intent_id) {
          await prepaid.refundPrepaidBooking({
            paymentIntentId: row.stripe_payment_intent_id,
            keepFraction: 0,
            appointmentId: row.id,
            calBookingUid: row.cal_event_id,
            reason: 'Full refund — canceled by admin',
            feeType: 'prepaid_admin_cancel_refund',
          });
        }
        await sql`
          UPDATE appointments
          SET status = 'canceled_by_admin',
              attached_to_appointment_id = NULL
          WHERE id::text = ${row.id}
        `;
      }

      if (sendSms) {
        const phone = ordered.find((row) => row.client_phone)?.client_phone || null;
        const optedIn = ordered.some((row) => row.sms_opt_in === true);
        const manageUid = ordered.find((row) => row.cal_event_id)?.cal_event_id || null;
        try {
          if (ordered.length === 1) {
            await notifyAdminAppointmentStatusSms({
              kind: 'admin_cancel',
              clientPhone: phone,
              smsOptIn: optedIn,
              serviceName: serviceTitle(ordered[0]?.service_name || null),
              bookingTime: isoOf(ordered[0]?.booking_time || null),
              bookingUid: manageUid,
            });
          } else {
            const line = joinThen(
              ordered.map((row) => {
                const start = isoOf(row.booking_time);
                const time = start ? studioTimeLabel(start) : '';
                const name = serviceTitle(row.service_name);
                return time ? `${name} at ${time}` : name;
              })
            );
            await notifyBulkDayChange({
              kind: 'admin_cancel_many',
              clientPhone: phone,
              smsOptIn: optedIn,
              visitServices: line,
              bookingTime: isoOf(ordered[0]?.booking_time || null),
              manageUid,
              serviceName: line,
            });
          }
        } catch (err) {
          console.warn('[api/admin/appointments/bulk-day] cancel text failed', err);
        }
      }

      return NextResponse.json({
        ok: true,
        cal_cancel_error: calErrors[0] || null,
      });
    }

    const startRaw = typeof body?.start === 'string' ? body.start.trim() : '';
    if (!startRaw) {
      return NextResponse.json(
        { ok: false, error: 'missing_start', message: 'Choose a new time.' },
        { status: 400 }
      );
    }
    let startUtc: Date;
    try {
      startUtc = parseBookingStartForCal(startRaw);
    } catch (err) {
      const message = err instanceof CalStartTimeError ? err.message : 'Invalid start time';
      return NextResponse.json({ ok: false, error: 'invalid_start', message }, { status: 400 });
    }

    const planned: PlannedVisit[] = [];
    let cursor = startUtc.getTime();
    for (const row of ordered) {
      const startIso = new Date(cursor).toISOString();
      cursor += row.durationMins * 60_000;
      planned.push({ ...row, startIso });
    }
    const blockEnd = new Date(cursor).toISOString();

    const created: Array<{ id: string; uid: string; oldUid: string | null }> = [];
    for (const row of planned) {
      const eventTypeId = Number(row.cal_event_type_id);
      if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) continue;
      await markAdminRescheduleIntent(row.id);
      if (row.cal_event_id) {
        try {
          await claimSkipClientSms(row.cal_event_id);
        } catch {
          /* a missed claim only risks a second text from Cal */
        }
      }
      const moved = await createCalBooking({
        eventTypeId,
        startIso: row.startIso,
        durationMins: row.durationMins,
        row,
      });
      if (!moved.ok) {
        for (const made of created) {
          await cancelOnCal(made.uid, ADMIN_CANCEL_REASON);
        }
        return NextResponse.json(
          { ok: false, error: 'calendar_move_failed', message: moved.message },
          { status: 502 }
        );
      }
      created.push({ id: row.id, uid: moved.uid, oldUid: row.cal_event_id });
    }

    const groups = new Map<string, VisitRow[]>();
    for (const row of byId.values()) {
      const key = row.parent_id || row.id;
      const list = groups.get(key) || [];
      list.push(row);
      groups.set(key, list);
    }
    for (const members of groups.values()) {
      const staying = members.filter((row) => !selectedIds.has(row.id)).map(withDuration).sort(byStart);
      const moving = members.some((row) => selectedIds.has(row.id));
      if (!moving || staying.length === 0) continue;
      const origin = Math.min(
        ...members.map((row) => new Date(isoOf(row.booking_time) || 0).getTime())
      );
      let stayCursor = origin;
      for (const row of staying) {
        const startIso = new Date(stayCursor).toISOString();
        const endIso = new Date(stayCursor + row.durationMins * 60_000).toISOString();
        stayCursor += row.durationMins * 60_000;
        await writeWindow(row.id, startIso, endIso, row.durationMins, 'confirmed');
      }
    }

    const newUidById = new Map(created.map((item) => [item.id, item.uid]));
    for (const row of planned) {
      const endIso = new Date(
        new Date(row.startIso).getTime() + row.durationMins * 60_000
      ).toISOString();
      await writeWindow(row.id, row.startIso, endIso, row.durationMins, 'confirmed');
      const newUid = newUidById.get(row.id);
      if (newUid) {
        await sql`
          UPDATE appointments
          SET cal_event_id = ${newUid}
          WHERE id::text = ${row.id}
        `;
      }
    }
    for (const made of created) {
      if (made.oldUid && made.oldUid !== made.uid) {
        await cancelOnCal(made.oldUid, ADMIN_CANCEL_REASON);
      }
      try {
        await rescheduleAppointmentReminderEmails(made.uid);
      } catch (err) {
        console.warn('[api/admin/appointments/bulk-day] reminder requeue failed', err);
      }
    }
    for (const row of planned) {
      if (newUidById.has(row.id) || !row.cal_event_id) continue;
      await cancelOnCal(row.cal_event_id, ADMIN_CANCEL_REASON);
      await sql`
        UPDATE appointments
        SET cal_event_id = NULL
        WHERE id::text = ${row.id}
      `;
    }

    if (sendSms) {
      const phone = planned.find((row) => row.client_phone)?.client_phone || null;
      const optedIn = planned.some((row) => row.sms_opt_in === true);
      const manageUid =
        created[0]?.uid || planned.find((row) => row.cal_event_id)?.cal_event_id || null;
      const line = joinThen(planned.map((row) => serviceTitle(row.service_name)));
      try {
        if (planned.length === 1) {
          await notifyAppointmentRescheduled({
            bookingUid: manageUid || '',
            bookingTime: planned[0]?.startIso || null,
            endTime: blockEnd,
            clientPhone: phone || '',
            serviceName: serviceTitle(planned[0]?.service_name || null),
            smsOptIn: optedIn,
            source: 'admin',
            sendClientSms: true,
            appointmentId: planned[0]?.id || null,
          });
        } else {
          await notifyBulkDayChange({
            kind: 'admin_reschedule_many',
            clientPhone: phone,
            smsOptIn: optedIn,
            visitServices: line,
            bookingTime: planned[0]?.startIso || null,
            endTime: blockEnd,
            manageUid,
            serviceName: line,
          });
        }
      } catch (err) {
        console.warn('[api/admin/appointments/bulk-day] reschedule text failed', err);
      }
    }

    return NextResponse.json({
      ok: true,
      start: planned[0]?.startIso || null,
      end: blockEnd,
    });
  } catch (err) {
    console.error('[api/admin/appointments/bulk-day] failed', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'bulk_failed',
        message: "We couldn't update those services. Please try again.",
      },
      { status: 500 }
    );
  }
}
