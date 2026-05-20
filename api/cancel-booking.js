/**
 * POST /api/cancel-booking
 * Body: { uid: string, reason?: string }
 *
 * Server-side proxy to Cal.com's v2 "Cancel a booking" endpoint. Cancelling
 * requires the Cal API key, so the request is funnelled through this function
 * to keep the credential off the client.
 *
 * Cal docs: https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking
 */

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

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true, uid });
  } catch (err) {
    console.error('[api/cancel-booking] fetch failed:', err);
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
};
