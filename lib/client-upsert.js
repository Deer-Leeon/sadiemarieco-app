/**
 * Phone-first client upsert for booking paths (public init, Cal webhook).
 * Email is stored when provided but does not identify the CRM row.
 *
 * Inserts omit has_consented / consent_form_url — Postgres defaults apply
 * (has_consented = false, consent_form_url = NULL) after
 * scripts/add_client_consent.sql.
 */

const { sql } = require('@vercel/postgres');
const {
  normaliseClientPhoneForStorage,
  clientPhoneLookupVariants,
  sqlPhoneVariants,
} = require('./client-phone.js');
const { normalizeClientEmailForStorage } = require('./client-email.js');

async function findClientIdByPhone(canonicalPhone) {
  for (const variant of clientPhoneLookupVariants(canonicalPhone)) {
    const { rows } = await sql`
      SELECT id FROM clients WHERE phone = ${variant} LIMIT 1
    `;
    if (rows[0]?.id) return rows[0].id;
  }
  return null;
}

async function clientPhoneExistsInDb(canonicalPhone) {
  return (await findClientIdByPhone(canonicalPhone)) !== null;
}

/**
 * @returns {Promise<{ clientId: string, normPhone: string }>}
 */
async function upsertClientByPhonePrimary({
  firstName,
  lastName,
  email,
  phoneRaw,
}) {
  const normPhone = normaliseClientPhoneForStorage(phoneRaw);
  if (!normPhone) {
    const err = new Error('phone_required');
    err.code = 'phone_required';
    throw err;
  }

  const trimmedEmail = normalizeClientEmailForStorage(email);

  const existingId = await findClientIdByPhone(normPhone);
  if (existingId) {
    await sql`
      UPDATE clients
      SET
        phone = ${normPhone},
        first_name = ${firstName},
        last_name = ${lastName},
        email = COALESCE(${trimmedEmail}, clients.email)
      WHERE id = ${existingId}
    `;
    return { clientId: existingId, normPhone };
  }

  if (trimmedEmail && !(await clientPhoneExistsInDb(normPhone))) {
    const [pv0, pv1] = sqlPhoneVariants(normPhone);
    const { rows: adopted } = await sql`
      UPDATE clients c
      SET
        phone = ${normPhone},
        first_name = ${firstName},
        last_name = ${lastName}
      WHERE c.phone IS NULL
        AND c.email IS NOT NULL
        AND LOWER(TRIM(c.email)) = LOWER(TRIM(${trimmedEmail}))
        AND NOT EXISTS (
          SELECT 1 FROM clients c2
          WHERE c2.phone = ${pv0} OR c2.phone = ${pv1}
        )
      RETURNING id
    `;
    if (adopted[0]?.id) {
      return { clientId: adopted[0].id, normPhone };
    }
  }

  const resolvedId = await findClientIdByPhone(normPhone);
  if (resolvedId) {
    await sql`
      UPDATE clients
      SET
        phone = ${normPhone},
        first_name = ${firstName},
        last_name = ${lastName},
        email = COALESCE(${trimmedEmail}, clients.email)
      WHERE id = ${resolvedId}
    `;
    return { clientId: resolvedId, normPhone };
  }

  try {
    const { rows: inserted } = await sql`
      INSERT INTO clients (phone, first_name, last_name, email)
      VALUES (${normPhone}, ${firstName}, ${lastName}, ${trimmedEmail})
      ON CONFLICT (phone) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        email = COALESCE(EXCLUDED.email, clients.email)
      RETURNING id
    `;
    const id = inserted[0]?.id;
    if (!id) throw new Error('phone upsert returned no id');
    return { clientId: id, normPhone };
  } catch (insertErr) {
    const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    const emailTaken =
      msg.includes('clients_email_key') ||
      (msg.toLowerCase().includes('duplicate key') && msg.includes('email'));
    if (!emailTaken) throw insertErr;

    const { rows: phoneOnly } = await sql`
      INSERT INTO clients (phone, first_name, last_name, email)
      VALUES (${normPhone}, ${firstName}, ${lastName}, NULL)
      ON CONFLICT (phone) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name
      RETURNING id
    `;
    const id = phoneOnly[0]?.id;
    if (!id) throw new Error('phone-only upsert returned no id');
    return { clientId: id, normPhone };
  }
}

/**
 * Legacy fallback when Cal sends no phone (rare). Keys by email only.
 * @returns {Promise<string|null>}
 */
async function upsertClientByEmailFallback({
  firstName,
  lastName,
  email,
  normPhone,
}) {
  const trimmedEmail = normalizeClientEmailForStorage(email);
  if (!trimmedEmail) return null;

  const phoneTaken = normPhone ? await clientPhoneExistsInDb(normPhone) : false;

  const { rows } = await sql`
    INSERT INTO clients (first_name, last_name, email, phone)
    VALUES (
      ${firstName},
      ${lastName},
      ${trimmedEmail},
      CASE
        WHEN ${normPhone}::text IS NULL THEN NULL
        WHEN ${phoneTaken} THEN NULL
        ELSE ${normPhone}
      END
    )
    ON CONFLICT (email) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      phone = COALESCE(clients.phone, EXCLUDED.phone)
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

module.exports = {
  upsertClientByPhonePrimary,
  upsertClientByEmailFallback,
  findClientIdByPhone,
};
