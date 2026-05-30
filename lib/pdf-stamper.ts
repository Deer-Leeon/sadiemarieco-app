/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 *
 * Field names must match the Sejda AcroForm template — see the translation
 * maps below (bridged from `INITIAL_FORM` in consent-form-config.ts).
 */
import { put } from '@vercel/blob';
import { PDFDocument, type PDFForm } from 'pdf-lib';
import { sql } from '@vercel/postgres';

import { CONSENT_STATEMENTS } from '@/app/consent/[clientId]/consent-form-config';
import type { ConsentFormData } from '@/lib/consent';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

const SIGNATURE_X = 100;
const SIGNATURE_Y = 150;
const SIGNATURE_WIDTH = 200;
const SIGNATURE_HEIGHT = 50;

/** Direct 1:1 text fields (form key → same PDF field name). */
const DIRECT_TEXT_FIELD_KEYS = [
  'dob',
  'phone',
  'address',
  'city',
  'state',
  'zip',
  'email',
  'occupation',
  'referral_source',
  'emergency_contact_name',
  'emergency_contact_phone',
] as const satisfies readonly (keyof ConsentFormData)[];

/**
 * Yes/No questions stored as `'yes' | 'no' | ''` in form state → PDF uses
 * `{base}_yes` and `{base}_no` checkboxes.
 */
const YES_NO_FORM_KEY_TO_PDF_BASE: Record<string, string> = {
  had_lash_lift_tint: 'prev_lash_lift',
  had_brow_lamination_tint: 'prev_brow_lam',
  wears_contact_lenses: 'contacts',
  eye_irritation_itching: 'eye_irritation',
  recurring_eye_infections: 'eye_infection_history',
  currently_eye_drops: 'eye_drops',
  pregnant_or_may_be: 'pregnant',
  eye_injury_or_condition: 'eye_injury',
  known_allergies: 'allergies',
  medications_supplements: 'medications',
  accutane_last_6_months: 'accutane',
  uses_retinol_tretinoin: 'retinol',
  chemotherapy_recent: 'chemo',
};

/** `medical_conditions_checklist` child key → PDF checkbox name. */
const MEDICAL_CONDITION_TO_PDF: Record<string, string> = {
  alopecia: 'cond_alopecia',
  conjunctivitis: 'cond_conjunctivitis',
  eczema: 'cond_eczema',
  psoriasis_near_eyes: 'cond_psoriasis',
  sensitive_eyes: 'cond_sensitive_eyes',
  cancer: 'cond_cancer',
  diabetes: 'cond_diabetes',
  glaucoma: 'cond_glaucoma',
  thyroid_disease: 'cond_thyroid',
  cataracts: 'cond_cataracts',
  dry_eyes: 'cond_dry_eyes',
  lupus: 'cond_lupus',
  recent_eye_infection: 'cond_recent_infection',
  other: 'cond_other',
};

const POLICY_FIELD_COUNT = 12;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function parseYesNo(value: unknown): 'yes' | 'no' | null {
  if (value === true || value === 'yes') return 'yes';
  if (value === false || value === 'no') return 'no';
  return null;
}

function trySetTextField(form: PDFForm, fieldName: string, text: string): void {
  if (!text) return;
  try {
    form.getTextField(fieldName).setText(text);
  } catch {
    /* missing or wrong field type */
  }
}

function tryCheckField(form: PDFForm, fieldName: string): void {
  try {
    form.getCheckBox(fieldName).check();
  } catch {
    /* missing or wrong field type */
  }
}

/**
 * PDF uses paired `{base}_yes` / `{base}_no` checkboxes; form uses one value.
 */
export function applyYesNoPairToPdf(
  form: PDFForm,
  pdfBaseName: string,
  value: unknown
): void {
  const answer = parseYesNo(value);
  if (answer === 'yes') {
    tryCheckField(form, `${pdfBaseName}_yes`);
  } else if (answer === 'no') {
    tryCheckField(form, `${pdfBaseName}_no`);
  }
}

function applyBooleanCheckbox(form: PDFForm, fieldName: string, value: unknown): void {
  if (value === true) {
    tryCheckField(form, fieldName);
  }
}

function applyTextFields(form: PDFForm, formData: ConsentFormData): void {
  const printName =
    stringValue(formData.agreement_print_name) ||
    stringValue(formData.full_name);
  if (printName) {
    trySetTextField(form, 'client_name', printName);
    trySetTextField(form, 'signature_print_name', printName);
  }

  const signatureDate = stringValue(formData.agreement_date);
  if (signatureDate) {
    trySetTextField(form, 'signature_date', signatureDate);
  }

  for (const key of DIRECT_TEXT_FIELD_KEYS) {
    const text = stringValue(formData[key]);
    if (text) {
      trySetTextField(form, key, text);
    }
  }
}

function applyYesNoFields(form: PDFForm, formData: ConsentFormData): void {
  for (const [formKey, pdfBase] of Object.entries(YES_NO_FORM_KEY_TO_PDF_BASE)) {
    applyYesNoPairToPdf(form, pdfBase, formData[formKey]);
  }
}

function applyMedicalConditions(form: PDFForm, formData: ConsentFormData): void {
  const checklist = formData.medical_conditions_checklist;
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) {
    return;
  }

  for (const [formKey, pdfField] of Object.entries(MEDICAL_CONDITION_TO_PDF)) {
    applyBooleanCheckbox(
      form,
      pdfField,
      (checklist as Record<string, unknown>)[formKey]
    );
  }

  const otherText = stringValue(formData.medical_conditions_other_text);
  if (otherText) {
    trySetTextField(form, 'cond_other_text', otherText);
  }
}

/**
 * `consent_statements` booleans → `policy_1` … `policy_12` in catalogue order.
 */
function applyConsentPolicies(form: PDFForm, formData: ConsentFormData): void {
  const statements = formData.consent_statements;
  if (!statements || typeof statements !== 'object' || Array.isArray(statements)) {
    return;
  }

  const map = statements as Record<string, unknown>;

  CONSENT_STATEMENTS.forEach((item, index) => {
    if (index >= POLICY_FIELD_COUNT) return;
    const policyField = `policy_${index + 1}`;
    applyBooleanCheckbox(form, policyField, map[item.key]);
  });
}

/**
 * Map `INITIAL_FORM` / submitted JSON to Sejda AcroForm field names.
 */
export function applyFormDataToPdf(form: PDFForm, formData: ConsentFormData): void {
  applyTextFields(form, formData);
  applyYesNoFields(form, formData);
  applyMedicalConditions(form, formData);
  applyConsentPolicies(form, formData);
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
