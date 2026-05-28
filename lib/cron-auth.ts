import { NextRequest, NextResponse } from 'next/server';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Resolve cron credential in order:
 *   1. Authorization: Bearer <secret>
 *   2. X-Cron-Secret: <secret>  (survives curl -L apex → www redirect)
 *   3. ?cron_secret=<secret>
 */
function readCronCredential(req: NextRequest): string | null {
  const bearer = readBearerToken(req);
  if (bearer) return bearer;

  const headerSecret = req.headers.get('x-cron-secret')?.trim();
  if (headerSecret) return headerSecret;

  const querySecret = req.nextUrl.searchParams.get('cron_secret')?.trim();
  if (querySecret) return querySecret;

  return null;
}

/**
 * @returns `null` when authorized; otherwise a 401/503 NextResponse.
 */
export function rejectUnlessCronAuthorized(
  req: NextRequest,
  logPrefix: string
): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error(`[${logPrefix}] CRON_SECRET not set — refusing to run`);
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 503 });
  }

  const token = readCronCredential(req);
  if (!token) {
    return NextResponse.json(
      {
        error: 'unauthorized',
        reason: 'missing_credentials',
        hint:
          'Use Authorization: Bearer <CRON_SECRET>, X-Cron-Secret (for curl -L on apex), or ?cron_secret= on the URL.',
      },
      { status: 401 }
    );
  }

  if (!timingSafeEqual(token, cronSecret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return null;
}
