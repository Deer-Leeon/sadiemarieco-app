/**
 * POST /api/admin/manual-booking/complete
 *
 * After the admin picks a slot in the Cal.com embed (step 3), confirm the
 * booking upstream and upsert the local appointments row — no Stripe checkout.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { bookingEndFromDurationMins } from '@/lib/booking-duration';
import { getCalComApiKey } from '@/lib/cal-config';
import { notifyBookingConfirmed } from '@/lib/booking-notifications';
import {
  clientPhoneExistsInDb,
  findClientIdByPhone,
} from '@/lib/client-phone-db';
import {
  clientPhoneValidationMessage,
  parseClientPhone,
  parseOptionalClientEmail,
  sqlPhoneVariants,
} from '@/lib/client-identity';
import {
  CAL_BOOKINGS_API_VERSION,
  CAL_V2_BASE,
  confirmCalV2Booking,
  errorMessage,
  gateAdmin,
} from '@/lib/cal-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CompleteBody {
  calBookingUid?: unknown;
  clientName?: unknown;
  clientEmail?: unknown;
  clientPhone?: unknown;
  serviceName?: unknown;
  bookingTime?: unknown;
  endTime?: unknown;
  durationMins?: unknown;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

function parseBody(input: unknown):
  | {
      calBookingUid: string;
      clientName: string;
      clientEmail: string | null;
      clientPhone: string;
      serviceName: string;
      bookingTime: string | null;
      endTime: string | null;
      durationMins: number | null;
    }
  | { error: string; message: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'invalid_body', message: 'Request body must be a JSON object' };
  }
  const body = input as CompleteBody;

  const calBookingUid =
    typeof body.calBookingUid === 'string' ? body.calBookingUid.trim() : '';
  const clientName =
    typeof body.clientName === 'string' ? body.clientName.trim() : '';
  const clientEmail = parseOptionalClientEmail(body.clientEmail);
  const parsedPhone = parseClientPhone(body.clientPhone);
  const serviceName =
    typeof body.serviceName === 'string' ? body.serviceName.trim() : '';
  const bookingTime =
    typeof body.bookingTime === 'string' ? body.bookingTime.trim() : null;
  const endTime = typeof body.endTime === 'string' ? body.endTime.trim() : null;
  const durationMinsRaw = body.durationMins;
  const durationMins =
    typeof durationMinsRaw === 'number' && Number.isFinite(durationMinsRaw)
      ? durationMinsRaw
      : typeof durationMinsRaw === 'string'
        ? Number(durationMinsRaw)
        : NaN;
  const parsedDurationMins =
    Number.isFinite(durationMins) && durationMins > 0 ? durationMins : null;

  if (!calBookingUid) {
    return { error: 'invalid_cal_booking_uid', message: 'calBookingUid is required' };
  }
  if (!clientName) {
    return { error: 'invalid_client_name', message: 'clientName is required' };
  }
  if (!parsedPhone) {
    return {
      error: 'invalid_client_phone',
      message: clientPhoneValidationMessage(),
    };
  }

  return {
    calBookingUid,
    clientName,
    clientEmail,
    clientPhone: parsedPhone.digits,
    serviceName: serviceName || 'appointment',
    bookingTime,
    endTime,
    durationMins: parsedDurationMins,
  };
}

/** Fetch start/end from Cal only when the client omitted bookingTime. */
async function fetchBookingTimesFromCal(
  uid: string
): Promise<{ bookingTime: string | null; endTime: string | null }> {
  const apiKey = getCalComApiKey();
  if (!apiKey) return { bookingTime: null, endTime: null };

  try {
    const res = await fetch(`${CAL_V2_BASE}/bookings/${encodeURIComponent(uid)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_BOOKINGS_API_VERSION,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return { bookingTime: null, endTime: null };

    const payload: unknown = await res.json().catch(() => null);
    const booking =
      payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data: Record<string, unknown> }).data
        : (payload as Record<string, unknown> | null);

    if (!booking || typeof booking !== 'object') {
      return { bookingTime: null, endTime: null };
    }

    const bookingTime =
      typeof booking.start === 'string'
        ? booking.start
        : typeof booking.startTime === 'string'
          ? booking.startTime
          : null;
    const endTime =
      typeof booking.end === 'string'
        ? booking.end
        : typeof booking.endTime === 'string'
          ? booking.endTime
          : null;

    return { bookingTime, endTime };
  } catch (err) {
    console.warn('[api/admin/manual-booking/complete] Cal hydrate failed', {
      uid,
      error: errorMessage(err),
    });
    return { bookingTime: null, endTime: null };
  }
}

function resolveAppointmentSchedule(parsed: {
  bookingTime: string | null;
  endTime: string | null;
  durationMins: number | null;
}): { bookingTime: string | null; endTime: string | null } {
  let { bookingTime, endTime } = parsed;

  if (!endTime && bookingTime && parsed.durationMins != null) {
    endTime =
      bookingEndFromDurationMins(bookingTime, parsed.durationMins) ?? endTime;
  }

  return { bookingTime, endTime };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await gateAdmin();
  if (gate) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const parsed = parseBody(raw);
  if ('error' in parsed) {
    return NextResponse.json(
      { error: parsed.error, message: parsed.message },
      { status: 400 }
    );
  }

  const confirmError = await confirmCalV2Booking(parsed.calBookingUid);
  if (confirmError) {
    console.warn('[api/admin/manual-booking/complete] confirm failed', {
      uid: parsed.calBookingUid,
      confirmError,
    });
  }

  let bookingTime = parsed.bookingTime;
  let endTime = parsed.endTime;

  if (!bookingTime) {
    const fromCal = await fetchBookingTimesFromCal(parsed.calBookingUid);
    bookingTime = fromCal.bookingTime;
    if (!endTime) endTime = fromCal.endTime;
  }

  const schedule = resolveAppointmentSchedule({
    bookingTime,
    endTime,
    durationMins: parsed.durationMins,
  });
  bookingTime = schedule.bookingTime;
  endTime = schedule.endTime;

  const appointmentServiceName = parsed.serviceName;

  if (!bookingTime) {
    return NextResponse.json(
      {
        error: 'missing_booking_time',
        message: 'Could not determine the appointment time from Cal.com.',
      },
      { status: 400 }
    );
  }

  const { first, last } = splitName(parsed.clientName);
  const normPhone = parsed.clientPhone;

  let clientId: string;
  try {
    const existingId = await findClientIdByPhone(normPhone);
    if (existingId) {
      clientId = existingId;
      await sql`
        UPDATE clients
        SET
          phone = ${normPhone},
          first_name = ${first},
          last_name = ${last},
          email = COALESCE(${parsed.clientEmail}, clients.email)
        WHERE id = ${clientId}
      `;
    } else if (parsed.clientEmail && !(await clientPhoneExistsInDb(normPhone))) {
      const [pv0, pv1] = sqlPhoneVariants(normPhone);
      const { rows: adopted } = await sql<{ id: string }>`
        UPDATE clients c
        SET
          phone = ${normPhone},
          first_name = ${first},
          last_name = ${last}
        WHERE c.phone IS NULL
          AND c.email IS NOT NULL
          AND LOWER(TRIM(c.email)) = LOWER(TRIM(${parsed.clientEmail}))
          AND NOT EXISTS (
            SELECT 1 FROM clients c2
            WHERE c2.phone = ${pv0} OR c2.phone = ${pv1}
          )
        RETURNING id
      `;
      if (adopted[0]?.id) {
        clientId = adopted[0].id;
      } else {
        const resolvedId = await findClientIdByPhone(normPhone);
        if (resolvedId) {
          clientId = resolvedId;
        } else {
          try {
            const { rows: inserted } = await sql<{ id: string }>`
              INSERT INTO clients (phone, first_name, last_name, email)
              VALUES (${normPhone}, ${first}, ${last}, ${parsed.clientEmail})
              ON CONFLICT (phone) DO UPDATE SET
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name
              RETURNING id
            `;
            const id = inserted[0]?.id;
            if (!id) throw new Error('phone upsert returned no id');
            clientId = id;
          } catch (insertErr) {
            const insertMsg = errorMessage(insertErr);
            const emailTaken =
              insertMsg.includes('clients_email_key') ||
              (insertMsg.toLowerCase().includes('duplicate key') &&
                insertMsg.includes('email'));
            if (!emailTaken) throw insertErr;

            const { rows: phoneOnly } = await sql<{ id: string }>`
              INSERT INTO clients (phone, first_name, last_name, email)
              VALUES (${normPhone}, ${first}, ${last}, NULL)
              ON CONFLICT (phone) DO UPDATE SET
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name
              RETURNING id
            `;
            const id = phoneOnly[0]?.id;
            if (!id) throw new Error('phone-only upsert returned no id');
            clientId = id;
          }
        }
      }
    } else {
      const resolvedId = await findClientIdByPhone(normPhone);
      if (resolvedId) {
        clientId = resolvedId;
        await sql`
          UPDATE clients
          SET
            phone = ${normPhone},
            first_name = ${first},
            last_name = ${last},
            email = COALESCE(${parsed.clientEmail}, clients.email)
          WHERE id = ${clientId}
        `;
      } else {
        const { rows: inserted } = await sql<{ id: string }>`
          INSERT INTO clients (phone, first_name, last_name, email)
          VALUES (${normPhone}, ${first}, ${last}, ${parsed.clientEmail})
          ON CONFLICT (phone) DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name
          RETURNING id
        `;
        const id = inserted[0]?.id;
        if (!id) throw new Error('phone upsert returned no id');
        clientId = id;
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: 'client_upsert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }

  try {
    await sql`
      INSERT INTO appointments (
        client_id, service_name, booking_time, end_time, cal_event_id,
        client_first_name, client_last_name, client_email, client_phone,
        status
      )
      VALUES (
        ${clientId}, ${appointmentServiceName}, ${bookingTime},
        ${endTime}, ${parsed.calBookingUid},
        ${first}, ${last}, ${parsed.clientEmail}, ${parsed.clientPhone},
        'confirmed'
      )
      ON CONFLICT (cal_event_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        service_name = EXCLUDED.service_name,
        booking_time = EXCLUDED.booking_time,
        end_time = EXCLUDED.end_time,
        client_first_name = EXCLUDED.client_first_name,
        client_last_name = EXCLUDED.client_last_name,
        client_email = COALESCE(EXCLUDED.client_email, appointments.client_email),
        client_phone = EXCLUDED.client_phone,
        status = 'confirmed'
    `;

    const notifications = await notifyBookingConfirmed({
      bookingUid: parsed.calBookingUid,
      bookingTime,
      endTime,
      clientPhone: parsed.clientPhone,
      clientName: parsed.clientName,
      serviceName: appointmentServiceName,
      clientId,
      clientEmail: parsed.clientEmail,
      skipIfAlreadySent: true,
      // Admin-created bookings: staff is initiating outreach for the client.
      smsOptIn: true,
    });

    return NextResponse.json({
      ok: true,
      calBookingUid: parsed.calBookingUid,
      status: 'confirmed',
      notifications,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'appointment_upsert_failed', message: errorMessage(err) },
      { status: 500 }
    );
  }
}
