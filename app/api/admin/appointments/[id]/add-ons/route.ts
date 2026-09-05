/**
 * POST /api/admin/appointments/[id]/add-ons
 * GET  /api/admin/appointments/[id]/add-ons
 *
 * Attach a catalogue extra onto an existing visit. The extra is a real
 * appointments row (needed because appointment_payments allows one
 * succeeded payment per appointment) with no Cal.com booking.
 */
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

import { requireAdminUser } from '@/app/admin/auth';
import type { Appointment } from '@/app/admin/types';
import { ensureAppointmentAttachedSchema } from '@/lib/appointment-attached';
import { loadCalEventTypeMaps } from '@/lib/cal-config';
import { isValidAppointmentId } from '@/lib/stripe-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Context {
  params: Promise<{ id: string }>;
}

interface ParentRow {
  id: string;
  client_id: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  stripe_customer_id: string | null;
  booking_time: Date | string | null;
  end_time: Date | string | null;
  status: string | null;
  attached_to_appointment_id: string | null;
  client_no_show_flag: boolean | null;
}

interface CatalogueRow {
  title: string;
  cal_event_id: number;
  slug: string | null;
  description: string | null;
  color: string | null;
  price: string | number | null;
}

function authError(reason: string): NextResponse {
  return NextResponse.json(
    { error: reason },
    { status: reason === 'unauthenticated' ? 401 : 403 }
  );
}

function serializeDate(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function loadParent(id: string): Promise<ParentRow | null> {
  await ensureAppointmentAttachedSchema();
  const { rows } = await sql<ParentRow>`
    SELECT
      a.id::text AS id,
      a.client_id::text AS client_id,
      a.client_first_name,
      a.client_last_name,
      a.client_email,
      a.client_phone,
      a.stripe_customer_id,
      a.booking_time,
      a.end_time,
      a.status,
      a.attached_to_appointment_id::text AS attached_to_appointment_id,
      FALSE AS client_no_show_flag
    FROM appointments a
    WHERE a.id::text = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadCatalogueService(args: {
  eventTypeId: number | null;
  slug: string | null;
}): Promise<CatalogueRow | null> {
  if (args.eventTypeId != null) {
    const { rows } = await sql<CatalogueRow>`
      SELECT title, cal_event_id, slug, description, color, price
      FROM site_services
      WHERE is_active = TRUE
        AND is_group = FALSE
        AND cal_event_id = ${args.eventTypeId}
      ORDER BY display_order ASC, id ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  if (args.slug) {
    const { rows } = await sql<CatalogueRow>`
      SELECT title, cal_event_id, slug, description, color, price
      FROM site_services
      WHERE is_active = TRUE
        AND is_group = FALSE
        AND slug = ${args.slug}
      ORDER BY display_order ASC, id ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  return null;
}

function extraToAppointment(args: {
  id: string;
  parent: ParentRow;
  service: CatalogueRow;
  bookingTime: Date | string | null;
  endTime: Date | string | null;
  serviceName: string;
  status: string | null;
  quotedCents: number | null;
}): Appointment {
  const price =
    args.quotedCents == null ? null : Number(args.quotedCents) / 100;
  return {
    id: args.id,
    cal_uid: null,
    client_first_name: args.parent.client_first_name,
    client_last_name: args.parent.client_last_name,
    booking_time: serializeDate(args.bookingTime),
    end_time: serializeDate(args.endTime),
    service_name: args.serviceName,
    status: args.status,
    client_phone: args.parent.client_phone,
    client_email: args.parent.client_email,
    booking_notes: null,
    service_price: Number.isFinite(price) ? price : null,
    service_description: args.service.description,
    service_slug: args.service.slug,
    service_color: args.service.color,
    stripe_customer_id: args.parent.stripe_customer_id,
    terminal_payment: null,
    client_no_show_flag: Boolean(args.parent.client_no_show_flag),
    attached_to_appointment_id: args.parent.id,
    extras: [],
    extra_count: 0,
  };
}

export async function GET(
  _req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const parent = await loadParent(id);
  if (!parent) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const maps = await loadCalEventTypeMaps();
    return NextResponse.json({
      services: maps.services,
      groupHeaders: maps.groupHeaders,
    });
  } catch (err) {
    console.error('[add-ons GET] catalogue load failed', err);
    return NextResponse.json(
      {
        error: 'catalogue_load_failed',
        message:
          err instanceof Error ? err.message : 'Could not load studio services.',
      },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  { params }: Context
): Promise<NextResponse> {
  const access = await requireAdminUser();
  if (!access.ok) return authError(access.reason);

  const { id } = await params;
  if (!isValidAppointmentId(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { eventTypeId?: unknown; slug?: unknown } = {};
  try {
    body = (await req.json()) as { eventTypeId?: unknown; slug?: unknown };
  } catch {
    body = {};
  }

  const eventTypeIdRaw =
    typeof body.eventTypeId === 'number'
      ? body.eventTypeId
      : typeof body.eventTypeId === 'string'
        ? Number(body.eventTypeId)
        : NaN;
  const eventTypeId =
    Number.isInteger(eventTypeIdRaw) && eventTypeIdRaw > 0
      ? eventTypeIdRaw
      : null;
  const slug =
    typeof body.slug === 'string' && body.slug.trim()
      ? body.slug.trim()
      : null;

  if (eventTypeId == null && !slug) {
    return NextResponse.json(
      {
        error: 'invalid_service',
        message: 'eventTypeId or slug is required.',
      },
      { status: 400 }
    );
  }

  try {
    const parent = await loadParent(id);
    if (!parent) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (parent.attached_to_appointment_id) {
      return NextResponse.json(
        {
          error: 'not_a_visit',
          message: 'Extras can only be added to a booked visit, not to another extra.',
        },
        { status: 409 }
      );
    }
    const status = (parent.status || '').toLowerCase();
    if (status !== 'confirmed') {
      return NextResponse.json(
        {
          error: 'parent_not_attachable',
          message: 'Extras can only be added to a confirmed visit.',
        },
        { status: 409 }
      );
    }

    const service = await loadCatalogueService({ eventTypeId, slug });
    if (!service) {
      return NextResponse.json(
        {
          error: 'service_not_found',
          message: 'No active catalogue service matches that extra.',
        },
        { status: 404 }
      );
    }

    const priceNum =
      service.price == null ? NaN : Number(service.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return NextResponse.json(
        {
          error: 'service_price_unavailable',
          message: 'That catalogue extra does not have a valid price.',
        },
        { status: 409 }
      );
    }
    const quotedCents = Math.round(priceNum * 100);
    const bookingTime = serializeDate(parent.booking_time);
    const endTime = serializeDate(parent.end_time);

    const { rows } = await sql<{
      id: string;
      booking_time: Date | string | null;
      end_time: Date | string | null;
      service_name: string | null;
      status: string | null;
      quoted_service_price_cents: number | null;
    }>`
      INSERT INTO appointments (
        client_id,
        service_name,
        booking_time,
        end_time,
        cal_event_id,
        cal_event_type_id,
        quoted_service_price_cents,
        client_first_name,
        client_last_name,
        client_email,
        client_phone,
        status,
        sms_opt_in,
        stripe_customer_id,
        attached_to_appointment_id
      )
      VALUES (
        ${parent.client_id},
        ${service.title},
        ${bookingTime},
        ${endTime},
        NULL,
        ${service.cal_event_id},
        ${quotedCents},
        ${parent.client_first_name},
        ${parent.client_last_name},
        ${parent.client_email},
        ${parent.client_phone},
        'confirmed',
        FALSE,
        ${parent.stripe_customer_id},
        ${parent.id}::uuid
      )
      RETURNING
        id::text AS id,
        booking_time,
        end_time,
        service_name,
        status,
        quoted_service_price_cents
    `;

    const inserted = rows[0];
    if (!inserted) {
      return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    }

    return NextResponse.json({
      extra: extraToAppointment({
        id: inserted.id,
        parent,
        service,
        bookingTime: inserted.booking_time,
        endTime: inserted.end_time,
        serviceName: inserted.service_name || service.title,
        status: inserted.status,
        quotedCents: inserted.quoted_service_price_cents,
      }),
    });
  } catch (err) {
    console.error('[add-ons POST] failed', err);
    return NextResponse.json(
      {
        error: 'add_on_failed',
        message:
          err instanceof Error ? err.message : 'Could not add that extra.',
      },
      { status: 500 }
    );
  }
}
