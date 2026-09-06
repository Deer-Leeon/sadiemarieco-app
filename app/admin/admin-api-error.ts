/**
 * Turn an admin API error body into a short message. Next.js 500s often
 * return an HTML error page; never dump that into the UI.
 */
export function userFacingAdminError(
  body: string,
  fallback = 'Something went wrong. Please try again.'
): string {
  const trimmed = body.trim();
  if (!trimmed) return fallback;
  if (looksLikeHtml(trimmed)) return fallback;

  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      error?: unknown;
    };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return shorten(parsed.message.trim(), fallback);
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      const code = parsed.error.trim();
      if (looksLikeHtml(code)) return fallback;
      if (/^[a-z0-9_]+$/i.test(code)) return fallback;
      return shorten(code, fallback);
    }
  } catch {
    // Not JSON — fall through.
  }

  return shorten(trimmed, fallback);
}

export async function readAdminFetchError(
  res: Response,
  fallback: string
): Promise<string> {
  const text = await res.text().catch(() => '');
  return userFacingAdminError(text, fallback);
}

function looksLikeHtml(value: string): boolean {
  const head = value.slice(0, 200).toLowerCase();
  return (
    head.startsWith('<!') ||
    head.startsWith('<html') ||
    head.includes('<!doctype') ||
    head.includes('<html') ||
    head.includes('__next_error__')
  );
}

function shorten(value: string, fallback: string): string {
  if (looksLikeHtml(value)) return fallback;
  if (value.length > 180) return fallback;
  return value;
}
