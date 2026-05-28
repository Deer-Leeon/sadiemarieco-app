/**
 * Shared Cal.com API v1 proxy helpers for admin routes.
 */

import { NextResponse } from 'next/server';

import { requireAdminUser } from '@/app/admin/auth';
import { CAL_V1_BASE, getCalComApiKey } from '@/lib/cal-config';

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
    console.error('[cal-v1-proxy] CALCOM_API_KEY / CAL_API_KEY is not set');
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

export async function proxyCalV1Get(
  path: string,
  query: Record<string, string>
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return { ok: false, response: apiKey };
  }

  const url = new URL(`${CAL_V1_BASE}${path}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
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
    console.error('[cal-v1-proxy] GET failed', { path, message });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'cal_fetch_failed', message },
        { status: 502 }
      ),
    };
  }
}

export async function proxyCalV1Post(
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const apiKey = requireCalApiKey();
  if (apiKey instanceof NextResponse) {
    return { ok: false, response: apiKey };
  }

  const url = new URL(`${CAL_V1_BASE}${path}`);
  url.searchParams.set('apiKey', apiKey);

  try {
    const upstream = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    console.error('[cal-v1-proxy] POST failed', { path, message });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'cal_fetch_failed', message },
        { status: 502 }
      ),
    };
  }
}
