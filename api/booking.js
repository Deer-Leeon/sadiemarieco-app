/**
 * GET /api/booking?uid=<bookingUid>
 *
 * Server-side proxy to Cal.com's v2 "Get booking" endpoint. The Cal API key
 * lives only on the server (read from CAL_API_KEY env var), so the magic-link
 * portal can fetch booking details without ever exposing credentials to the
 * browser.
 *
 * Cal docs: https://cal.com/docs/api-reference/v2/bookings/get-a-booking
 */

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const uid = (req.query && req.query.uid ? String(req.query.uid) : '').trim();
  if (!uid) {
    return res.status(400).json({ error: 'missing_uid' });
  }

  const apiKey = process.env.CAL_API_KEY;
  if (!apiKey) {
    console.error('[api/booking] CAL_API_KEY is not set');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  try {
    const upstream = await fetch(`${CAL_API_BASE}/bookings/${encodeURIComponent(uid)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
        Accept: 'application/json'
      }
    });

    const payload = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      // Cal returns 404 for unknown bookings — treat as "invalid link"
      // so the client can render the expired/invalid state cleanly.
      const status = upstream.status === 404 ? 404 : 502;
      return res.status(status).json({
        error: upstream.status === 404 ? 'booking_not_found' : 'upstream_error',
        upstreamStatus: upstream.status,
        upstreamMessage: payload && (payload.message || payload.error) || null
      });
    }

    const booking = (payload && payload.data) || payload;
    if (!booking || !booking.uid) {
      return res.status(404).json({ error: 'booking_not_found' });
    }

    // Whitelist only the fields the portal actually needs. Keeps the response
    // small and avoids leaking PII (e.g. host email) to the client.
    const attendee = Array.isArray(booking.attendees) && booking.attendees[0] || {};
    const host = Array.isArray(booking.hosts) && booking.hosts[0] || {};
    const eventType = booking.eventType || {};

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      uid: booking.uid,
      title: booking.title || null,
      status: booking.status || 'unknown',
      start: booking.start || null,
      end: booking.end || null,
      duration: booking.duration || null,
      location: booking.location || booking.meetingUrl || null,
      eventType: {
        id: eventType.id || null,
        slug: eventType.slug || null
      },
      host: {
        name: host.name || null,
        username: host.username || null,
        timeZone: host.timeZone || null
      },
      attendee: {
        name: attendee.name || null,
        timeZone: attendee.timeZone || null
      },
      rescheduledFromUid: booking.rescheduledFromUid || null,
      cancellationReason: booking.cancellationReason || null
    });
  } catch (err) {
    console.error('[api/booking] fetch failed:', err);
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
};
