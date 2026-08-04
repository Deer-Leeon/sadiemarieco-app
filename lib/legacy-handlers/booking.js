/**
 * GET /api/booking?uid=<bookingUid>
 *
 * Server-side proxy to Cal.com's v2 "Get booking" endpoint. The Cal API key
 * lives only on the server (read from CAL_API_KEY env var), so the magic-link
 * portal can fetch booking details without ever exposing credentials to the
 * browser.
 *
 * Also attaches a `change_fee` preview (tier + dollar amount) so /manage can
 * warn before cancel/reschedule — same windows as the Cal webhook charges.
 *
 * Cal docs: https://cal.com/docs/api-reference/v2/bookings/get-a-booking
 */

const { sql } = require('@vercel/postgres');
const {
  classifyClientCancelPenalty,
  penaltyAmountCents,
  LATE_CANCEL_FRACTION,
  NO_SHOW_CANCEL_FRACTION,
} = require('../late-cancel-charge');

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

function formatUsdFromCents(cents) {
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

/**
 * Resolve late-change / no-show fee preview for the manage portal.
 * Best-effort: missing appointment row → tier from Cal start only, no $.
 */
async function loadChangeFeePreview(uid, startIso) {
  const tier = classifyClientCancelPenalty(startIso);
  const empty = {
    tier,
    fraction: 0,
    amount_cents: 0,
    amount_display: null,
    waived: false,
    has_card_on_file: false,
    service_price: null,
  };

  if (tier === 'none') {
    return empty;
  }

  const fraction =
    tier === 'no_show_full' ? NO_SHOW_CANCEL_FRACTION : LATE_CANCEL_FRACTION;

  try {
    const { resolveClientId } = require('../client-change-counters.js');

    const { rows } = await sql`
      SELECT
        a.stripe_customer_id,
        a.booking_time,
        a.end_time,
        a.service_name,
        a.client_id::text AS client_id,
        a.client_phone,
        a.quoted_service_price_cents::numeric / 100 AS service_price,
        c.late_change_waive_next,
        c.no_show_waive_next
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      LEFT JOIN LATERAL (
        SELECT s.price
        FROM site_services s
        WHERE s.title = split_part(a.service_name, ' between ', 1)
          AND s.is_active = TRUE
          AND (
            lower(trim(split_part(a.service_name, ' between ', 1))) NOT IN (
              'classic', 'hybrid', 'volume'
            )
            OR (
              a.booking_time IS NOT NULL
              AND a.end_time IS NOT NULL
              AND s.duration_mins IS NOT NULL
              AND s.duration_mins = GREATEST(
                1,
                ROUND(
                  EXTRACT(EPOCH FROM (a.end_time - a.booking_time)) / 60.0
                )
              )::integer
            )
          )
        ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE a.cal_event_id = ${uid}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) {
      return { ...empty, fraction };
    }

    let lateWaive = row.late_change_waive_next;
    let noShowWaive = row.no_show_waive_next;

    // Appointment may lack client_id — resolve by phone and read waive flags.
    if (
      lateWaive === null &&
      noShowWaive === null &&
      (row.client_id || row.client_phone)
    ) {
      const resolvedId = await resolveClientId(
        row.client_id || null,
        row.client_phone || null
      );
      if (resolvedId) {
        const { rows: clientRows } = await sql`
          SELECT late_change_waive_next, no_show_waive_next
          FROM clients
          WHERE id = ${resolvedId}::uuid
          LIMIT 1
        `;
        if (clientRows[0]) {
          lateWaive = clientRows[0].late_change_waive_next;
          noShowWaive = clientRows[0].no_show_waive_next;
        }
      }
    }

    // Only treat as waived when the client row explicitly still has the pass.
    // Missing client must NOT default to waived (false courtesy message).
    const waived =
      tier === 'no_show_full' ? noShowWaive === true : lateWaive === true;

    const priceRaw =
      row.service_price === null || row.service_price === undefined
        ? NaN
        : Number(row.service_price);
    const amountCents = waived ? 0 : penaltyAmountCents(priceRaw, fraction);
    const hasCard =
      typeof row.stripe_customer_id === 'string' &&
      /^cus_[A-Za-z0-9]+$/.test(row.stripe_customer_id.trim());

    return {
      tier,
      fraction,
      amount_cents: amountCents,
      amount_display: formatUsdFromCents(amountCents),
      waived,
      has_card_on_file: hasCard,
      service_price: Number.isFinite(priceRaw) ? priceRaw : null,
    };
  } catch (err) {
    console.warn('[api/booking] change_fee preview failed (non-fatal)', {
      uid,
      error: err && err.message,
    });
    return { ...empty, fraction };
  }
}

async function loadAppointmentExtras(uid) {
  try {
    const { rows } = await sql`
      SELECT sms_opt_in
      FROM appointments
      WHERE cal_event_id = ${uid}
      LIMIT 1
    `;
    const row = rows[0];
    return {
      sms_opt_in: row ? row.sms_opt_in === true : false,
    };
  } catch (err) {
    console.warn('[api/booking] appointment extras lookup failed (non-fatal)', {
      uid,
      error: err && err.message,
    });
    return { sms_opt_in: false };
  }
}

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
    const start = booking.start || null;
    const startMs = start ? Date.parse(start) : NaN;
    const canModify =
      Number.isFinite(startMs) ? startMs > Date.now() : true;

    const changeFee = await loadChangeFeePreview(booking.uid, start);
    const extras = await loadAppointmentExtras(booking.uid);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      uid: booking.uid,
      title: booking.title || null,
      status: booking.status || 'unknown',
      start,
      end: booking.end || null,
      duration: booking.duration || null,
      location: booking.location || booking.meetingUrl || null,
      can_modify: canModify,
      change_fee: changeFee,
      sms_opt_in: extras.sms_opt_in,
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
