/**
 * Same-client, same-Denver-day visit snapshot for SMS / reminder email.
 * Remaining confirmed Cal bookings (not admin extras) share one arrival time.
 */

const crypto = require('crypto');
const { sql } = require('@vercel/postgres');
const {
  formatServiceTitle,
  formatStudioDate,
  formatStudioTime,
} = require('./sms-appointment-copy.js');

const STUDIO_TZ = 'America/Denver';
const HOUR_MS = 60 * 60 * 1000;

function isoFromSql(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function phoneDigits(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

function denverDateKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function visitKey({ clientId, phone, dateKey }) {
  const id =
    typeof clientId === 'string' && clientId.trim()
      ? clientId.trim()
      : `p${phoneDigits(phone) || 'unknown'}`;
  return `visit:${id}:${dateKey}`;
}

function visitFingerprint(services) {
  const payload = (services || [])
    .map((s) => `${s.uid}|${s.bookingTime}`)
    .join(';');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function visitQstashLeadKey(visitKeyValue) {
  return `${visitKeyValue}:qstash_sms:lead`;
}

function visitLeadSentKey(visitKeyValue) {
  return `${visitKeyValue}:sms_sent:lead`;
}

function visitNotifiedFpKey(visitKeyValue, fingerprint) {
  return `${visitKeyValue}:notified_fp:${fingerprint}`;
}

function visitQstashReviewKey(visitKeyValue) {
  return `${visitKeyValue}:qstash_sms:review_request`;
}

function visitReviewSentKey(visitKeyValue) {
  return `${visitKeyValue}:sms_sent:review_request`;
}

async function webhookExists(key) {
  if (!key) return false;
  try {
    const { rows } = await sql`
      SELECT 1 FROM webhook_events WHERE booking_uid = ${key} LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn('[same-day-visit] webhook_events lookup failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function tryClaimWebhookEvent(key) {
  try {
    const { rows } = await sql`
      INSERT INTO webhook_events (booking_uid)
      VALUES (${key})
      ON CONFLICT (booking_uid) DO NOTHING
      RETURNING booking_uid
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn('[same-day-visit] webhook_events claim failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function releaseWebhookEventClaim(key) {
  try {
    await sql`DELETE FROM webhook_events WHERE booking_uid = ${key}`;
  } catch (err) {
    console.warn('[same-day-visit] webhook_events release failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadAnchorAppointment(bookingUid) {
  if (!bookingUid) return null;
  const { rows } = await sql`
    SELECT
      id::text AS id,
      cal_event_id,
      client_id::text AS client_id,
      client_phone,
      service_name,
      cal_event_type_id,
      booking_time,
      end_time,
      status,
      sms_opt_in
    FROM appointments
    WHERE cal_event_id = ${bookingUid}
    LIMIT 1
  `;
  return rows[0] || null;
}

function mapServiceRow(row) {
  const bookingTime = isoFromSql(row.booking_time);
  const endTime = isoFromSql(row.end_time) || bookingTime;
  return {
    id: String(row.id),
    uid: String(row.cal_event_id || '').trim(),
    clientId: row.client_id ? String(row.client_id) : null,
    clientPhone: row.client_phone || null,
    serviceName: row.service_name || 'appointment',
    calEventTypeId: row.cal_event_type_id == null ? null : Number(row.cal_event_type_id),
    bookingTime,
    endTime,
    smsOptIn: row.sms_opt_in,
    displayName: formatServiceTitle(row.service_name),
    reminderKind: null,
  };
}

async function loadVisitRows(anchor, { remainingOnly = true } = {}) {
  const bookingTime = isoFromSql(anchor.booking_time);
  if (!bookingTime) return [];
  const dateKey = denverDateKey(bookingTime);
  if (!dateKey) return [];

  const clientId = anchor.client_id ? String(anchor.client_id) : null;
  const digits = phoneDigits(anchor.client_phone);
  const digitsPlus1 = digits.length === 10 ? `1${digits}` : '';
  const digitsTrim1 =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : '';

  const { rows } = remainingOnly
    ? await sql`
        SELECT
          a.id::text AS id,
          a.cal_event_id,
          a.client_id::text AS client_id,
          a.client_phone,
          a.service_name,
          a.cal_event_type_id,
          a.booking_time,
          a.end_time,
          a.status,
          a.sms_opt_in
        FROM appointments a
        WHERE LOWER(COALESCE(a.status, '')) = 'confirmed'
          AND a.attached_to_appointment_id IS NULL
          AND a.cal_event_id IS NOT NULL
          AND TRIM(a.cal_event_id) <> ''
          AND a.booking_time IS NOT NULL
          AND COALESCE(a.end_time, a.booking_time) > NOW()
          AND to_char(a.booking_time AT TIME ZONE ${STUDIO_TZ}, 'YYYY-MM-DD') = ${dateKey}
          AND (
            (
              ${clientId}::text IS NOT NULL
              AND a.client_id IS NOT NULL
              AND a.client_id::text = ${clientId}
            )
            OR (
              ${digits} <> ''
              AND regexp_replace(COALESCE(a.client_phone, ''), '\\D', '', 'g') <> ''
              AND (
                regexp_replace(a.client_phone, '\\D', '', 'g') = ${digits}
                OR (
                  ${digitsPlus1} <> ''
                  AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsPlus1}
                )
                OR (
                  ${digitsTrim1} <> ''
                  AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsTrim1}
                )
              )
            )
          )
        ORDER BY a.booking_time ASC, a.id::text ASC
      `
    : await sql`
        SELECT
          a.id::text AS id,
          a.cal_event_id,
          a.client_id::text AS client_id,
          a.client_phone,
          a.service_name,
          a.cal_event_type_id,
          a.booking_time,
          a.end_time,
          a.status,
          a.sms_opt_in
        FROM appointments a
        WHERE LOWER(COALESCE(a.status, '')) = 'confirmed'
          AND a.attached_to_appointment_id IS NULL
          AND a.cal_event_id IS NOT NULL
          AND TRIM(a.cal_event_id) <> ''
          AND a.booking_time IS NOT NULL
          AND to_char(a.booking_time AT TIME ZONE ${STUDIO_TZ}, 'YYYY-MM-DD') = ${dateKey}
          AND (
            (
              ${clientId}::text IS NOT NULL
              AND a.client_id IS NOT NULL
              AND a.client_id::text = ${clientId}
            )
            OR (
              ${digits} <> ''
              AND regexp_replace(COALESCE(a.client_phone, ''), '\\D', '', 'g') <> ''
              AND (
                regexp_replace(a.client_phone, '\\D', '', 'g') = ${digits}
                OR (
                  ${digitsPlus1} <> ''
                  AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsPlus1}
                )
                OR (
                  ${digitsTrim1} <> ''
                  AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsTrim1}
                )
              )
            )
          )
        ORDER BY a.booking_time ASC, a.id::text ASC
      `;
  return rows;
}

async function hydrateReminderKinds(services) {
  if (!services.length) return services;
  try {
    const lookup = await import('./appointment-service-lookup');
    for (const service of services) {
      const resolved = await lookup.resolveAppointmentService(
        service.serviceName,
        service.bookingTime,
        service.endTime,
        service.calEventTypeId
      );
      service.displayName = resolved.displayName || service.displayName;
      service.reminderKind =
        resolved.reminderKind ||
        lookup.inferReminderKindFromServiceName(service.serviceName);
    }
  } catch (err) {
    console.warn('[same-day-visit] reminder kind lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return services;
}

function leadKindFromServices(services) {
  if (services.some((s) => s.reminderKind === 'brows')) return '48h';
  return '24h';
}

function leadOffsetMs(leadKind) {
  return leadKind === '48h' ? 48 * HOUR_MS : 24 * HOUR_MS;
}

function visitPrep(services) {
  const hasLashes = services.some((s) => s.reminderKind === 'lashes');
  const hasBrows = services.some((s) => s.reminderKind === 'brows');
  const parts = [];
  if (hasLashes) {
    parts.push(
      'For lashes: come with clean lashes and no eye makeup, and skip caffeine for at least 4-6 hours before.'
    );
  }
  if (hasBrows) {
    parts.push(
      "For brows: come with clean brows and no makeup, and skip retinol or tretinoin until after your appointment."
    );
  }
  if (!parts.length) return 'Please arrive a few minutes early.';
  return parts.join(' ');
}

function visitServicesLine(services) {
  if (!services.length) return 'your appointment';
  return services
    .map((s, i) => {
      const when = formatStudioTime(s.bookingTime);
      const name = s.displayName || formatServiceTitle(s.serviceName);
      if (i === 0) return `${name} at ${when}`;
      return `then ${name} at ${when}`;
    })
    .join(', ');
}

function assembleVisit(anchor, services) {
  const bookingTime = isoFromSql(anchor.booking_time);
  const dateKey = bookingTime ? denverDateKey(bookingTime) : null;
  const key = dateKey
    ? visitKey({
        clientId: anchor.client_id,
        phone: anchor.client_phone,
        dateKey,
      })
    : null;
  const fingerprint = visitFingerprint(services);
  const arrival = services[0] || null;
  const last = services.reduce((best, s) => {
    if (!best) return s;
    const bestEnd = Date.parse(best.endTime || best.bookingTime || '') || 0;
    const end = Date.parse(s.endTime || s.bookingTime || '') || 0;
    return end >= bestEnd ? s : best;
  }, null);
  const leadKind = leadKindFromServices(services);
  return {
    key,
    dateKey,
    fingerprint,
    services,
    isMulti: services.length > 1,
    canonicalUid: arrival ? arrival.uid : null,
    lastUid: last ? last.uid : null,
    arrivalTime: arrival ? arrival.bookingTime : bookingTime,
    lastEndTime: last ? last.endTime || last.bookingTime : null,
    leadKind,
    leadOffsetMs: leadOffsetMs(leadKind),
    clientPhone: arrival?.clientPhone || anchor.client_phone,
    smsOptIn: arrival?.smsOptIn || anchor.sms_opt_in,
    visitServices: visitServicesLine(services),
    visitPrep: visitPrep(services),
    dateLabel: arrival ? formatStudioDate(arrival.bookingTime) : '',
    arrivalTimeLabel: arrival ? formatStudioTime(arrival.bookingTime) : '',
  };
}

/**
 * Remaining confirmed Cal bookings that day for this client.
 * Includes this uid when it is still confirmed and not finished.
 */
async function listUpcomingVisitCanonicalUids(bookingUid) {
  const anchor = await loadAnchorAppointment(bookingUid);
  if (!anchor) return [];
  const clientId = anchor.client_id ? String(anchor.client_id) : null;
  const digits = phoneDigits(anchor.client_phone);
  const digitsPlus1 = digits.length === 10 ? `1${digits}` : '';
  const digitsTrim1 =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : '';

  const { rows } = await sql`
    SELECT
      a.cal_event_id,
      a.booking_time
    FROM appointments a
    WHERE LOWER(COALESCE(a.status, '')) = 'confirmed'
      AND a.attached_to_appointment_id IS NULL
      AND a.cal_event_id IS NOT NULL
      AND TRIM(a.cal_event_id) <> ''
      AND a.booking_time IS NOT NULL
      AND COALESCE(a.end_time, a.booking_time) > NOW()
      AND a.booking_time < NOW() + INTERVAL '60 days'
      AND (
        (
          ${clientId}::text IS NOT NULL
          AND a.client_id IS NOT NULL
          AND a.client_id::text = ${clientId}
        )
        OR (
          ${digits} <> ''
          AND regexp_replace(COALESCE(a.client_phone, ''), '\\D', '', 'g') <> ''
          AND (
            regexp_replace(a.client_phone, '\\D', '', 'g') = ${digits}
            OR (
              ${digitsPlus1} <> ''
              AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsPlus1}
            )
            OR (
              ${digitsTrim1} <> ''
              AND regexp_replace(a.client_phone, '\\D', '', 'g') = ${digitsTrim1}
            )
          )
        )
      )
    ORDER BY a.booking_time ASC, a.cal_event_id ASC
  `;
  const seen = new Set();
  const uids = [];
  for (const row of rows) {
    const uid = String(row.cal_event_id || '').trim();
    const dateKey = denverDateKey(isoFromSql(row.booking_time));
    if (!uid || !dateKey || seen.has(dateKey)) continue;
    seen.add(dateKey);
    uids.push(uid);
  }
  return uids;
}

async function loadVisitForBookingUid(bookingUid, { remainingOnly = true } = {}) {
  const anchor = await loadAnchorAppointment(bookingUid);
  if (!anchor) return null;
  let rows = [];
  try {
    rows = await loadVisitRows(anchor, { remainingOnly });
  } catch (err) {
    console.warn('[same-day-visit] sibling lookup failed', {
      bookingUid,
      error: err instanceof Error ? err.message : String(err),
    });
    if (
      String(anchor.status || '').toLowerCase() === 'confirmed' &&
      String(anchor.cal_event_id || '').trim()
    ) {
      rows = [anchor];
    }
  }
  const services = rows.map(mapServiceRow).filter((s) => s.uid);
  await hydrateReminderKinds(services);
  if (!services.length) {
    return assembleVisit(anchor, []);
  }
  return assembleVisit(anchor, services);
}

function visitCopyVars(visit, { serviceName = '', manageUrl = '' } = {}) {
  return {
    service: serviceName || visit.visitServices,
    date: visit.dateLabel,
    time: visit.arrivalTimeLabel,
    arrivalTime: visit.arrivalTimeLabel,
    visitServices: visit.visitServices,
    visitPrep: visit.visitPrep,
    manageUrl: manageUrl || '',
  };
}

async function wasVisitLeadSent(visit) {
  if (!visit) return false;
  if (visit.key && (await webhookExists(visitLeadSentKey(visit.key)))) {
    return true;
  }
  for (const service of visit.services || []) {
    if (await webhookExists(`${service.uid}:sms_sent:lead`)) return true;
  }
  return false;
}

async function wasVisitFingerprintNotified(visit) {
  if (!visit?.key || !visit.fingerprint) return false;
  return webhookExists(visitNotifiedFpKey(visit.key, visit.fingerprint));
}

async function markVisitFingerprintNotified(visit) {
  if (!visit?.key || !visit.fingerprint) return;
  await tryClaimWebhookEvent(visitNotifiedFpKey(visit.key, visit.fingerprint));
}

async function markVisitLeadSent(visit, bookingUid) {
  if (visit?.key) {
    await tryClaimWebhookEvent(visitLeadSentKey(visit.key));
  }
  if (bookingUid) {
    await tryClaimWebhookEvent(`${bookingUid}:sms_sent:lead`);
  }
  await markVisitFingerprintNotified(visit);
}

async function hasVisitThankYouSent(visit) {
  if (!visit) return false;
  if (visit.key && (await webhookExists(visitReviewSentKey(visit.key)))) {
    return true;
  }
  for (const service of visit.services || []) {
    if (await webhookExists(`${service.uid}:sms_sent:review_request`)) {
      return true;
    }
    if (await webhookExists(`${service.uid}:sms_sent:feedback`)) {
      return true;
    }
  }
  return false;
}

async function markVisitThankYouSent(visit, bookingUid) {
  if (visit?.key) {
    await tryClaimWebhookEvent(visitReviewSentKey(visit.key));
  }
  if (bookingUid) {
    await tryClaimWebhookEvent(`${bookingUid}:sms_sent:review_request`);
    await tryClaimWebhookEvent(`${bookingUid}:sms_sent:feedback`);
  }
}

module.exports = {
  STUDIO_TZ,
  isoFromSql,
  denverDateKey,
  visitKey,
  visitFingerprint,
  visitQstashLeadKey,
  visitLeadSentKey,
  visitNotifiedFpKey,
  visitQstashReviewKey,
  visitReviewSentKey,
  loadVisitForBookingUid,
  listUpcomingVisitCanonicalUids,
  visitCopyVars,
  wasVisitLeadSent,
  wasVisitFingerprintNotified,
  markVisitFingerprintNotified,
  markVisitLeadSent,
  hasVisitThankYouSent,
  markVisitThankYouSent,
  tryClaimWebhookEvent,
  releaseWebhookEventClaim,
  webhookExists,
};
