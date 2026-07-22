/**
 * One-shot: clear Cal placeholder emails from clients + appointments.
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-clear-placeholder-emails.mjs
 */
import { sql } from '@vercel/postgres';

const { rows: clientBefore } = await sql`
  SELECT COUNT(*)::int AS n FROM clients
  WHERE email IS NOT NULL
    AND (
      LOWER(TRIM(email)) LIKE '%@sms.cal.com'
      OR LOWER(TRIM(email)) LIKE 'bookings+%'
      OR LOWER(TRIM(email)) LIKE '%@placeholder.sadiemarie.co'
    )
`;

const { rows: apptBefore } = await sql`
  SELECT COUNT(*)::int AS n FROM appointments
  WHERE client_email IS NOT NULL
    AND (
      LOWER(TRIM(client_email)) LIKE '%@sms.cal.com'
      OR LOWER(TRIM(client_email)) LIKE 'bookings+%'
      OR LOWER(TRIM(client_email)) LIKE '%@placeholder.sadiemarie.co'
    )
`;

const clientsCleared = await sql`
  UPDATE clients
  SET email = NULL
  WHERE email IS NOT NULL
    AND (
      LOWER(TRIM(email)) LIKE '%@sms.cal.com'
      OR LOWER(TRIM(email)) LIKE 'bookings+%'
      OR LOWER(TRIM(email)) LIKE '%@placeholder.sadiemarie.co'
    )
`;

const apptsCleared = await sql`
  UPDATE appointments
  SET client_email = NULL
  WHERE client_email IS NOT NULL
    AND (
      LOWER(TRIM(client_email)) LIKE '%@sms.cal.com'
      OR LOWER(TRIM(client_email)) LIKE 'bookings+%'
      OR LOWER(TRIM(client_email)) LIKE '%@placeholder.sadiemarie.co'
    )
`;

console.log('✓ Cleared Cal placeholder emails', {
  clientsMatched: clientBefore[0]?.n ?? 0,
  clientsUpdated: clientsCleared.rowCount ?? 0,
  appointmentsMatched: apptBefore[0]?.n ?? 0,
  appointmentsUpdated: apptsCleared.rowCount ?? 0,
});
