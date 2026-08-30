import { sql } from '@vercel/postgres';

import { scheduleReviewRequestForClient } from '@/lib/booking-notifications';

export function serializeOptionalIso(
  value: Date | string | null | undefined
): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function parseStoredGoogleReviewStars(
  value: number | string | null | undefined
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

export type GoogleReviewStarsPatchParse =
  | { present: false }
  | { present: true; invalid: false; value: number | null }
  | { present: true; invalid: true };

/**
 * PATCH body for `google_review_stars`.
 * `undefined` = field omitted; `null` = clear; 1–5 = set.
 */
export function parseGoogleReviewStarsPatch(
  raw: unknown
): GoogleReviewStarsPatchParse {
  if (raw === undefined) return { present: false };
  if (raw === null) return { present: true, invalid: false, value: null };
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return { present: true, invalid: true };
  }
  return { present: true, invalid: false, value: n };
}

export function reviewFlagsFromRow(row: {
  review_request_pending?: boolean | null;
  google_review_noted?: boolean | null;
  google_review_stars?: number | string | null;
  google_review_noted_at?: Date | string | null;
  review_request_last_sent_at?: Date | string | null;
}): {
  review_request_pending: boolean;
  google_review_noted: boolean;
  google_review_stars: number | null;
  google_review_noted_at: string | null;
  review_request_last_sent_at: string | null;
} {
  const stars = parseStoredGoogleReviewStars(row.google_review_stars);
  return {
    review_request_pending: Boolean(row.review_request_pending),
    google_review_noted: stars !== null || Boolean(row.google_review_noted),
    google_review_stars: stars,
    google_review_noted_at: serializeOptionalIso(row.google_review_noted_at),
    review_request_last_sent_at: serializeOptionalIso(
      row.review_request_last_sent_at
    ),
  };
}

/**
 * Apply profile review-request / Google-star updates.
 * Setting any star count (1–5) records a review and clears the
 * ask-after-visit box. Clearing stars does not turn the ask box back on.
 * Turning the ask box on queues a QStash job for an upcoming confirmed visit.
 */
export async function patchClientReviewFlags(
  clientId: string,
  patch: {
    reviewRequestPending?: boolean;
    googleReviewNoted?: boolean;
    googleReviewStars?: number | null;
  }
): Promise<{ found: boolean; queuedReviewSms: boolean }> {
  const setPending = patch.reviewRequestPending;
  const starsInPatch = Object.hasOwn(patch, 'googleReviewStars');
  let nextStars: number | null | undefined;
  if (starsInPatch) {
    nextStars = patch.googleReviewStars ?? null;
  } else if (patch.googleReviewNoted === true) {
    nextStars = 5;
  } else if (patch.googleReviewNoted === false) {
    nextStars = null;
  }

  if (nextStars === undefined && setPending === undefined) {
    return { found: true, queuedReviewSms: false };
  }

  let found = false;

  if (nextStars !== undefined && nextStars !== null) {
    const { rows } = await sql`
      UPDATE clients
      SET
        google_review_stars = ${nextStars},
        google_review_noted = TRUE,
        google_review_noted_at = COALESCE(google_review_noted_at, NOW()),
        review_request_pending = FALSE
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
  } else if (nextStars === null) {
    const { rows } = await sql`
      UPDATE clients
      SET
        google_review_stars = NULL,
        google_review_noted = FALSE,
        google_review_noted_at = NULL
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
  }

  if (setPending === true && typeof nextStars !== 'number') {
    const { rows } = await sql`
      UPDATE clients
      SET review_request_pending = TRUE
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
    if (found) {
      try {
        await scheduleReviewRequestForClient(clientId);
        return { found: true, queuedReviewSms: true };
      } catch (err) {
        console.warn('[client-review-flags] schedule after PATCH failed', {
          clientId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { found, queuedReviewSms: false };
  }

  if (setPending === false && typeof nextStars !== 'number') {
    const { rows } = await sql`
      UPDATE clients
      SET review_request_pending = FALSE
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
  }

  return { found, queuedReviewSms: false };
}
