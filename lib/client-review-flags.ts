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

export function reviewFlagsFromRow(row: {
  review_request_pending?: boolean | null;
  google_review_noted?: boolean | null;
  google_review_noted_at?: Date | string | null;
  review_request_last_sent_at?: Date | string | null;
}): {
  review_request_pending: boolean;
  google_review_noted: boolean;
  google_review_noted_at: string | null;
  review_request_last_sent_at: string | null;
} {
  return {
    review_request_pending: Boolean(row.review_request_pending),
    google_review_noted: Boolean(row.google_review_noted),
    google_review_noted_at: serializeOptionalIso(row.google_review_noted_at),
    review_request_last_sent_at: serializeOptionalIso(
      row.review_request_last_sent_at
    ),
  };
}

/**
 * Apply profile review-request / noted-review toggles.
 * Checking “noted a Google review” always clears the ask-after-visit box.
 * Turning the ask box on queues a QStash job for an upcoming confirmed visit.
 */
export async function patchClientReviewFlags(
  clientId: string,
  patch: {
    reviewRequestPending?: boolean;
    googleReviewNoted?: boolean;
  }
): Promise<{ found: boolean; queuedReviewSms: boolean }> {
  const setNoted = patch.googleReviewNoted;
  const setPending = patch.reviewRequestPending;

  if (setNoted === undefined && setPending === undefined) {
    return { found: true, queuedReviewSms: false };
  }

  let found = false;

  if (setNoted === true) {
    const { rows } = await sql`
      UPDATE clients
      SET
        google_review_noted = TRUE,
        google_review_noted_at = COALESCE(google_review_noted_at, NOW()),
        review_request_pending = FALSE
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
  } else if (setNoted === false) {
    const { rows } = await sql`
      UPDATE clients
      SET
        google_review_noted = FALSE,
        google_review_noted_at = NULL
      WHERE id = ${clientId}::uuid
      RETURNING id
    `;
    found = rows.length > 0;
  }

  if (setPending === true && setNoted !== true) {
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

  if (setPending === false && setNoted !== true) {
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
