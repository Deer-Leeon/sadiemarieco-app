/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 */
import { put } from '@vercel/blob';
import { PDFDocument } from 'pdf-lib';
import { sql } from '@vercel/postgres';

import type { ConsentFormData } from '@/lib/consent';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

const SIGNATURE_X = 100;
const SIGNATURE_Y = 150;
const SIGNATURE_WIDTH = 200;
const SIGNATURE_HEIGHT = 50;

type PdfFieldEntry = { key: string; value: unknown };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flatten `formData` into PDF field names. Nested objects (e.g.
 * `medical_conditions_checklist`, `consent_statements`) expand to their
 * child keys at the root level.
 */
export function flattenFormDataForPdf(formData: ConsentFormData): PdfFieldEntry[] {
  const entries: PdfFieldEntry[] = [];

  for (const [key, value] of Object.entries(formData)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        entries.push({ key: nestedKey, value: nestedValue });
      }
    } else {
      entries.push({ key, value });
    }
  }

  return entries;
}

function trySetTextField(form: ReturnType<PDFDocument['getForm']>, key: string, text: string): void {
  try {
    form.getTextField(key).setText(text);
  } catch {
    /* field missing or wrong type — skip */
  }
}

function tryCheckField(form: ReturnType<PDFDocument['getForm']>, key: string): void {
  try {
    form.getCheckBox(key).check();
  } catch {
    /* field missing or wrong type — skip */
  }
}

/**
 * Map a single logical value onto a PDF form field by name.
 * Booleans and `"yes"` check boxes; other strings fill text fields.
 */
export function applyValueToPdfField(
  form: ReturnType<PDFDocument['getForm']>,
  key: string,
  value: unknown
): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'boolean') {
    if (value) tryCheckField(form, key);
    return;
  }

  if (typeof value === 'number') {
    trySetTextField(form, String(key), String(value));
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed === 'yes') {
      tryCheckField(form, key);
      return;
    }
    if (trimmed === 'no') {
      return;
    }
    trySetTextField(form, key, trimmed);
  }
}

export function applyFormDataToPdf(
  form: ReturnType<PDFDocument['getForm']>,
  formData: ConsentFormData
): void {
  for (const { key, value } of flattenFormDataForPdf(formData)) {
    applyValueToPdfField(form, key, value);
  }
}

function parseSignaturePngBytes(signatureBase64: string): Uint8Array {
  const trimmed = signatureBase64.trim();
  const base64 = trimmed.includes(',')
    ? trimmed.slice(trimmed.indexOf(',') + 1)
    : trimmed;
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function fetchTemplatePdfBuffer(templateUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(templateUrl, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch consent PDF template (${res.status} ${res.statusText})`
    );
  }
  return res.arrayBuffer();
}

async function loadTemplateUrl(): Promise<string> {
  const { rows } = await sql<{ consent_pdf_url: string | null }>`
    SELECT consent_pdf_url
    FROM studio_settings
    WHERE id = ${STUDIO_SETTINGS_ROW_ID}
    LIMIT 1
  `;
  const url = rows[0]?.consent_pdf_url?.trim();
  if (!url) {
    throw new Error(
      'No consent PDF template configured. Upload one in Admin → Settings.'
    );
  }
  return url;
}

/**
 * Load the studio template, stamp fields + signature, upload to Blob.
 */
export async function stampConsentPDF(
  clientId: string,
  formData: ConsentFormData,
  signatureBase64: string
): Promise<string> {
  const templateUrl = await loadTemplateUrl();
  const buffer = await fetchTemplatePdfBuffer(templateUrl);

  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();

  applyFormDataToPdf(form, formData);

  const signatureBytes = parseSignaturePngBytes(signatureBase64);
  const signatureImage = await pdfDoc.embedPng(signatureBytes);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  lastPage.drawImage(signatureImage, {
    x: SIGNATURE_X,
    y: SIGNATURE_Y,
    width: SIGNATURE_WIDTH,
    height: SIGNATURE_HEIGHT,
  });

  form.flatten();

  const pdfBytes = await pdfDoc.save();

  const pathname = `client-consents/${clientId}-signed.pdf`;
  let blob;
  try {
    blob = await put(pathname, Buffer.from(pdfBytes), {
      access: 'public',
      contentType: 'application/pdf',
      allowOverwrite: true,
    });
  } catch (err) {
    console.error('[pdf-stamper] blob put failed:', errorMessage(err));
    throw new Error('Failed to upload stamped consent PDF');
  }

  return blob.url;
}
