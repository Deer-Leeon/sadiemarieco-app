import { NextRequest, NextResponse } from 'next/server';

import { handleManageChange } from '@/lib/manage-visit-change';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const query: Record<string, string | undefined> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const result = await handleManageChange('GET', query, null);
  return NextResponse.json(result.json, { status: result.status });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await handleManageChange('POST', {}, body);
  return NextResponse.json(result.json, { status: result.status });
}
