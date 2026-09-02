// Usage:
//   node --env-file=.env.local scripts/run-appointments-cal-event-type-id-migration.mjs
import { sql } from '@vercel/postgres';

await sql.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS cal_event_type_id INTEGER NULL
`);

await sql.query(`
  CREATE INDEX IF NOT EXISTS appointments_cal_event_type_id_idx
    ON appointments (cal_event_type_id)
    WHERE cal_event_type_id IS NOT NULL
`);

await sql.query(`
CREATE OR REPLACE FUNCTION set_appointment_quoted_service_price()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quoted_service_price_cents IS NULL THEN
    SELECT ROUND(s.price * 100)::integer
    INTO NEW.quoted_service_price_cents
    FROM site_services s
    WHERE s.is_active = TRUE
      AND (
        (
          NEW.cal_event_type_id IS NOT NULL
          AND s.cal_event_id = NEW.cal_event_type_id
        )
        OR (
          NEW.cal_event_type_id IS NULL
          AND s.title = split_part(NEW.service_name, ' between ', 1)
          AND (
            lower(trim(split_part(NEW.service_name, ' between ', 1))) NOT IN (
              'classic', 'hybrid', 'volume'
            )
            OR (
              NEW.booking_time IS NOT NULL
              AND NEW.end_time IS NOT NULL
              AND s.duration_mins IS NOT NULL
              AND s.duration_mins = GREATEST(
                1,
                ROUND(
                  EXTRACT(EPOCH FROM (NEW.end_time - NEW.booking_time)) / 60.0
                )
              )::integer
            )
          )
        )
      )
    ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$
`);

const STOP = new Set(['a', 'and', 'plus', 'the', 'with']);

function titleKey(raw) {
  if (!raw) return '';
  const primary = String(raw).split(/\s+between\s+/i)[0] ?? '';
  const tokens = primary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP.has(token));
  tokens.sort();
  return tokens.join(' ');
}

function stripAddOn(key) {
  const tokens = key.split(' ').filter(Boolean);
  if (!tokens.includes('add') || !tokens.includes('on')) return key;
  return tokens.filter((token) => token !== 'add' && token !== 'on').join(' ');
}

const { rows: services } = await sql`
  SELECT cal_event_id, title
  FROM site_services
  WHERE is_active = TRUE
    AND cal_event_id IS NOT NULL
`;

const { rows: appts } = await sql`
  SELECT id, service_name
  FROM appointments
  WHERE cal_event_type_id IS NULL
`;

let linked = 0;
let renamed = 0;

for (const appt of appts) {
  const key = titleKey(appt.service_name);
  if (!key) continue;

  let hits = services.filter((row) => titleKey(row.title) === key);
  if (hits.length !== 1) {
    const stripped = stripAddOn(key);
    if (stripped && stripped !== key) {
      const addOnHits = services.filter((row) => titleKey(row.title) === stripped);
      if (addOnHits.length === 1) hits = addOnHits;
    }
  }
  if (hits.length !== 1) continue;

  const match = hits[0];
  const storedTitle = String(appt.service_name || '')
    .split(/\s+between\s+/i)[0]
    ?.trim();
  const shouldRename = storedTitle && storedTitle !== match.title;

  if (shouldRename) {
    await sql`
      UPDATE appointments
      SET
        cal_event_type_id = ${match.cal_event_id},
        service_name = CASE
          WHEN service_name ILIKE '% between %'
            THEN ${match.title} || ' between ' || split_part(service_name, ' between ', 2)
          ELSE ${match.title}
        END
      WHERE id = ${appt.id}
    `;
    renamed += 1;
  } else {
    await sql`
      UPDATE appointments
      SET cal_event_type_id = ${match.cal_event_id}
      WHERE id = ${appt.id}
    `;
  }
  linked += 1;
}

console.log(
  `✓ appointments.cal_event_type_id migration applied. Linked ${linked} row(s); renamed ${renamed} stale title(s).`,
);
