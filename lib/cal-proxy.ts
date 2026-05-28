/**
 * Shared Cal.com API v2 proxy helpers for admin routes.
 */

import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { getCalComApiKey } from '@/lib/cal-config';
import { parseBookingStartForCal } from '@/lib/cal-timezone';

export const CAL_V2_BASE = 'https://api.cal.com/v2';

/** Slots endpoint (2024-09-04). */
export const CAL_SLOTS_API_VERSION = '2024-09-04';

/** Bookings create / confirm (matches /api/booking/confirm). */
export const CAL_BOOKINGS_API_VERSION = '2024-08-13';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function gateAdmin(): Promise<NextResponse | null> {
  const access = await requireAdminUser();
  if (access.ok) return null;
  return NextResponse.json(
    { error: access.reason },
    { status: access.reason === 'unauthenticated' ? 401 : 403 }
  );
}

export function requireCalApiKey(): string | NextResponse {
  const apiKey = getCalComApiKey();
  if (!apiKey) {
    console.error('[cal-proxy] CALCOM_API_KEY / CAL_API_KEY is not set');
    return NextResponse.json(
      { error: 'server_misconfigured', message: 'Cal.com API key is not configured' },
      { status: 500 }
    );
  }
  return apiKey;
}

export function calUpstreamErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const p = payload as {
      message?: string;
      error?: string;
      errors?: Array<{ message?: string }>;
    };
    if (typeof p.message === 'string' && p.message) return p.message;
    if (typeof p.error === 'string' && p.error) return p.error;
    const nested = p.errors?.[0]?.message;
    if (typeof nested === 'string' && nested) return nested;
  }
  return `Cal.com returned HTTP ${status}`;
}

function calV2Headers(apiKey: string, apiVersion: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'cal-api-version': apiVersion,
  };
}

export async function proxyCalV2Get(
  path: string,
  query: Record<string, string>,
  apiVersion: string
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return { ok: false, response: apiKey };
  }

  const url = new URL(`${CAL_V2_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: calV2Headers(apiKey, apiVersion),
      cache: 'no-store',
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: 'cal_upstream_error',
            status: upstream.status,
            message: calUpstreamErrorMessage(data, upstream.status),
            details: data,
          },
          { status: upstream.status >= 500 ? 502 : upstream.status }
        ),
      };
    }
    return { ok: true, data };
  } catch (err) {
    const message = errorMessage(err);
    console.error('[cal-proxy] GET failed', { path, message });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'cal_fetch_failed', message },
        { status: 502 }
      ),
    };
  }
}

export async function proxyCalV2Post(
  path: string,
  body: Record<string, unknown>,
  apiVersion: string
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return { ok: false, response: apiKey };
  }

  try {
    const upstream = await fetch(`${CAL_V2_BASE}${path}`, {
      method: 'POST',
      headers: {
        ...calV2Headers(apiKey, apiVersion),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: 'cal_upstream_error',
            status: upstream.status,
            message: calUpstreamErrorMessage(data, upstream.status),
            details: data,
          },
          { status: upstream.status >= 500 ? 502 : upstream.status }
        ),
      };
    }
    return { ok: true, data };
  } catch (err) {
    const message = errorMessage(err);
    console.error('[cal-proxy] POST failed', { path, message });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'cal_fetch_failed', message },
        { status: 502 }
      ),
    };
  }
}

/** Confirm a pending booking (v2). */
export async function confirmCalV2Booking(
  bookingUid: string
): Promise<string | null> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return 'Cal.com API key is not configured';
  }

  try {
    const res = await fetch(
      `${CAL_V2_BASE}/bookings/${encodeURIComponent(bookingUid)}/confirm`,
      {
        method: 'POST',
        headers: calV2Headers(apiKey, CAL_BOOKINGS_API_VERSION),
        cache: 'no-store',
      }
    );
    if (res.ok) return null;
    const payload: unknown = await res.json().catch(() => null);
    return calUpstreamErrorMessage(payload, res.status);
  } catch (err) {
    return errorMessage(err);
  }
}

function slotItemToUtcIso(item: unknown, date: string): string | null {
  if (typeof item === 'string') {
    if (item.includes('T')) {
      const instant = new Date(item);
      return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
    }
    if (/^\d{1,2}:\d{2}/.test(item)) {
      const time = item.length <= 5 ? `${item}:00` : item;
      try {
        return parseBookingStartForCal(`${date}T${time}`).toISOString();
      } catch {
        return null;
      }
    }
    return null;
  }

  if (item && typeof item === 'object') {
    const o = item as { time?: unknown; start?: unknown };
    if (typeof o.time === 'string') return slotItemToUtcIso(o.time, date);
    if (typeof o.start === 'string') return slotItemToUtcIso(o.start, date);
  }

  return null;
}

/**
 * Normalize Cal.com v2 slots payloads to the v1-style shape the admin modal expects.
 */
export function normalizeCalSlotsForDate(
  payload: unknown,
  date: string
): { slots: Record<string, string[]> } {
  if (!payload || typeof payload !== 'object') {
    return { slots: { [date]: [] } };
  }

  const root = payload as Record<string, unknown>;
  let slotsMap: Record<string, unknown> | null = null;

  if (root.slots && typeof root.slots === 'object') {
    slotsMap = root.slots as Record<string, unknown>;
  } else if (root.data && typeof root.data === 'object') {
    const data = root.data as Record<string, unknown>;
    if (data.slots && typeof data.slots === 'object') {
      slotsMap = data.slots as Record<string, unknown>;
    } else {
      slotsMap = data;
    }
  }

  const daySlots = slotsMap?.[date];
  if (!Array.isArray(daySlots)) {
    return { slots: { [date]: [] } };
  }

  const times = daySlots
    .map((item) => slotItemToUtcIso(item, date))
    .filter((t): t is string => t !== null);

  return { slots: { [date]: times } };
}
