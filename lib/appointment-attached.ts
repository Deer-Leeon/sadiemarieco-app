import 'server-only';

import { sql } from '@vercel/postgres';

let ensureSchemaPromise: Promise<void> | null = null;

/**
 * Idempotent — staging (and any other DB) may not have been migrated yet.
 * Mirrors `scripts/run-add-appointment-attached-to-migration.mjs`.
 */
export async function ensureAppointmentAttachedSchema(): Promise<void> {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await sql.query(`
        ALTER TABLE appointments
          ADD COLUMN IF NOT EXISTS attached_to_appointment_id UUID NULL
      `);
      await sql.query(`
        ALTER TABLE appointments
          ALTER COLUMN cal_event_id DROP NOT NULL
      `);
      await sql.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'appointments_attached_to_appointment_id_fkey'
          ) THEN
            ALTER TABLE appointments
              ADD CONSTRAINT appointments_attached_to_appointment_id_fkey
              FOREIGN KEY (attached_to_appointment_id)
              REFERENCES appointments(id)
              ON DELETE CASCADE;
          END IF;
        END
        $$
      `);
      await sql.query(`
        CREATE INDEX IF NOT EXISTS appointments_attached_to_idx
          ON appointments (attached_to_appointment_id)
          WHERE attached_to_appointment_id IS NOT NULL
      `);
    })().catch((err) => {
      ensureSchemaPromise = null;
      throw err;
    });
  }
  await ensureSchemaPromise;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function syncAttachedExtrasTimes(
  parentId: string,
  bookingTime: string | Date | null,
  endTime: string | Date | null
): Promise<void> {
  if (!parentId) return;
  const startIso = toIsoTimestamp(bookingTime);
  const endIso = toIsoTimestamp(endTime);
  await sql`
    UPDATE appointments
    SET booking_time = ${startIso},
        end_time = ${endIso}
    WHERE attached_to_appointment_id::text = ${parentId}
  `;
}

/**
 * Drop extras that were never settled when the parent visit is canceled.
 * Paid extras stay nested on the canceled visit for history.
 */
export async function deleteUnsettledAttachedExtras(
  parentId: string
): Promise<void> {
  if (!parentId) return;
  await sql`
    DELETE FROM appointments extra
    WHERE extra.attached_to_appointment_id::text = ${parentId}
      AND NOT EXISTS (
        SELECT 1
        FROM appointment_payments p
        WHERE p.appointment_id = extra.id::text
          AND p.status = 'succeeded'
      )
  `;
}
