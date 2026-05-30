/**
 * Lists AcroForm field names from the uploaded consent template.
 * Usage: npx tsx --env-file=.env.local scripts/list-consent-pdf-fields.ts
 */
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { sql } from '@vercel/postgres';

async function main() {
  const { rows } = await sql<{ consent_pdf_url: string | null }>`
    SELECT consent_pdf_url FROM studio_settings WHERE id = 1 LIMIT 1
  `;
  const url = rows[0]?.consent_pdf_url?.trim();
  if (!url) {
    console.error('No consent_pdf_url in studio_settings');
    process.exit(1);
  }

  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const pdf = await PDFDocument.load(buffer);
  const form = pdf.getForm();

  for (const field of form.getFields()) {
    console.log(`${field.constructor.name}\t${field.getName()}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
