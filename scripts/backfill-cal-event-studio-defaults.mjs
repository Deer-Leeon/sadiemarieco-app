/**
 * Backfill Cal.com studio defaults on every active bookable event type.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-cal-event-studio-defaults.mjs
 *
 * Sets auto-confirm, in-person address, and booking fields.
 */
import { sql } from '@vercel/postgres';

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-06-14';

const STUDIO_IN_PERSON_ADDRESS =
  '61 W 3200 N, Suite #10, Lehi, UT 84043';

const STUDIO_BOOKING_FIELDS = [
  {
    type: 'splitName',
    firstNameLabel: 'First name',
    firstNamePlaceholder: 'First name',
    lastNameLabel: 'Last name',
    lastNamePlaceholder: 'Last name',
    lastNameRequired: true,
  },
  {
    type: 'phone',
    slug: 'attendeePhoneNumber',
    label: 'Phone number',
    required: true,
    placeholder: '+1 555 123 4567',
    hidden: false,
  },
];

function calHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'cal-api-version': CAL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function calJson(path, apiKey, init) {
  const res = await fetch(`${CAL_API_BASE}${path}`, {
    ...init,
    headers: { ...calHeaders(apiKey), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const message =
      (payload &&
        typeof payload === 'object' &&
        (payload.message ||
          (payload.error &&
            typeof payload.error === 'object' &&
            payload.error.message) ||
          payload.error)) ||
      `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return payload;
}

async function patchStudioDefaults(calEventId, apiKey) {
  await calJson(`/event-types/${calEventId}`, apiKey, {
    method: 'PATCH',
    body: JSON.stringify({
      bookingFields: STUDIO_BOOKING_FIELDS,
      confirmationPolicy: { disabled: true },
      locations: [
        {
          type: 'address',
          address: STUDIO_IN_PERSON_ADDRESS,
          public: true,
        },
      ],
    }),
  });
}

const apiKey =
  process.env.CALCOM_API_KEY?.trim() || process.env.CAL_API_KEY?.trim();
if (!apiKey) {
  console.error('Missing CALCOM_API_KEY or CAL_API_KEY in environment.');
  process.exit(1);
}

const { rows } = await sql`
  SELECT id, title, cal_event_id
  FROM site_services
  WHERE is_active = TRUE
    AND is_group = FALSE
    AND cal_event_id IS NOT NULL
  ORDER BY display_order ASC, id ASC
`;

if (rows.length === 0) {
  console.log('No active bookable services with cal_event_id found.');
  process.exit(0);
}

console.log(`Patching ${rows.length} Cal event type(s)...`);

let ok = 0;
let failed = 0;

for (const row of rows) {
  const label = `${row.title} (local #${row.id}, Cal #${row.cal_event_id})`;
  try {
    await patchStudioDefaults(row.cal_event_id, apiKey);
    console.log(`✓ ${label}`);
    ok += 1;
  } catch (err) {
    console.error(`✗ ${label}:`, err instanceof Error ? err.message : err);
    failed += 1;
  }
}

console.log(`Done. ${ok} succeeded, ${failed} failed.`);

if (failed > 0) process.exit(1);
