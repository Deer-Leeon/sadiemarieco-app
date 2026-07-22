/**
 * One-shot cleanup: clear corrupted `appointments.booking_notes` values
 * that were written as the literal string "[object Object]" when Cal
 * sent an empty notes field wrapper without a string `value`.
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-clear-object-booking-notes.mjs
 */
import { sql } from '@vercel/postgres';

async function main() {
  const { rowCount } = await sql`
    UPDATE appointments
    SET booking_notes = NULL
    WHERE trim(booking_notes) = '[object Object]'
  `;
  console.log(
    `Cleared ${rowCount ?? 0} appointment(s) with corrupted booking_notes.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
