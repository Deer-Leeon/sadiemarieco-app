/**
 * POST /api/cancel-booking
 * Body: { uid: string, reason?: string }
 *
 * Server-side proxy to Cal.com's v2 "Cancel a booking" endpoint. Cancelling
 * requires the Cal API key, so the request is funnelled through this function
 * to keep the credential off the client.
 *
 * After Cal acknowledges the cancellation, this handler also flips the local
 * `appointments.status` to 'cancelled' so the QStash-driven reminder/feedback
 * jobs (api/remind, api/feedback) skip the SMS when they fire later. The DB
 * write is best-effort: a failure here is logged loudly but does NOT fail the
 * response — the cancellation has already taken effect upstream at Cal.
 *
 * Cal docs: https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking
 */

const { sql } = require('@vercel/postgres');

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

const readJsonBody = (req) => new Promise((resolve, reject) => {
  // Vercel parses JSON bodies into req.body automatically when the
  // Content-Type is application/json, but we read manually as a fallback
  // in case the body is delivered as a raw stream.
  if (req.body && typeof req.body === 'object') return resolve(req.body);
  if (typeof req.body === 'string' && req.body.length) {
    try { return resolve(JSON.parse(req.body)); }
    catch (e) { return reject(e); }
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); }
    catch (e) { reject(e); }
  });
  req.on('error', reject);
});

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const uid = (body && body.uid ? String(body.uid) : '').trim();
  const reason = (body && body.reason ? String(body.reason) : 'Cancelled by client via management portal').slice(0, 500);

  if (!uid) {
    return res.status(400).json({ error: 'missing_uid' });
  }

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/cancel-booking] CAL_API_KEY is not set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  try {
    const upstream = await fetch(`${CAL_API_BASE}/bookings/${encodeURIComponent(uid)}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ cancellationReason: reason })
    });

    const payload = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const status = upstream.status === 404 ? 404 : 502;
      return res.status(status).json({
        error: upstream.status === 404 ? 'booking_not_found' : 'upstream_error',
        upstreamStatus: upstream.status,
        upstreamMessage: payload && (payload.message || payload.error) || null
      });
    }

    // ── LOCAL STATUS UPDATE ──────────────────────────────────────────────
    // Cal has accepted the cancellation. This route is hit ONLY from the
    // public manage portal (`public/manage.html` + `public/js/manage.js`),
    // which is always a client-initiated cancel, so we mark the row as
    // 'canceled_by_client' to match the new lifecycle vocabulary in
    // `app/admin/types.ts` + `scripts/update_status_constraint.sql`.
    //
    // Preserve any prior 'canceled_by_admin' status — that's a strictly
    // more specific value and the BOOKING_CANCELLED webhook does the
    // same guard. Best-effort write: if this fails the cancellation is
    // still effective at Cal (the user won't show up), the worst case is
    // a stale reminder firing 24h later. We never propagate a DB failure
    // back to the portal — that would invite a retry that 404s against
    // Cal because the booking is already cancelled.
    //
    // 0 rows affected is not an error: either we don't have an
    // appointment row for this UID (legacy booking) or the row was
    // already canceled_by_admin and the guard short-circuited.
    // RETURNING lets us log which case we hit without an extra SELECT.
    try {
      const { rows: updatedRows } = await sql`
        UPDATE appointments
        SET status = 'canceled_by_client'
        WHERE cal_event_id = ${uid}
          AND (status IS NULL OR status <> 'canceled_by_admin')
        RETURNING cal_event_id
      `;
      if (updatedRows.length === 0) {
        console.warn('[api/cancel-booking] no appointment row matched on cancel (or admin-cancel preserved)', { uid });
      } else {
        console.log('[api/cancel-booking] appointment marked canceled_by_client', { uid });
      }
    } catch (dbErr) {
      console.error('[api/cancel-booking] DB status update failed (Cal cancel succeeded):', {
        uid,
        error: dbErr && dbErr.message,
      });
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true, uid });
  } catch (err) {
    console.error('[api/cancel-booking] fetch failed:', err);
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
};
