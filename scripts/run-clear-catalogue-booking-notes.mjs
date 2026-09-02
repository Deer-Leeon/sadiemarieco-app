/**
 * Clear `appointments.booking_notes` that were copied from the Cal
 * event-type / catalogue service description instead of the client's
 * Additional notes field.
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-clear-catalogue-booking-notes.mjs
 */
import { sql } from '@vercel/postgres';

async function main() {
  const { rowCount } = await sql`
    UPDATE appointments a
    SET booking_notes = NULL
    WHERE a.booking_notes IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM site_services s
        WHERE s.description IS NOT NULL
          AND trim(a.booking_notes) = trim(s.description)
      )
  `;
  console.log(
    `Cleared ${rowCount ?? 0} appointment(s) whose booking notes were the service description.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
