/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 *
 * Maps `INITIAL_FORM` JSON keys to Sejda AcroForm field names (see dictionaries
 * below). All `setText` / `check` calls are wrapped in try/catch.
 */
import { put } from '@vercel/blob';
import { PDFDocument, type PDFForm } from 'pdf-lib';
import { sql } from '@vercel/postgres';

import type { ConsentFormData } from '@/lib/consent';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

const SIGNATURE_X = 150;
const SIGNATURE_Y = 280;
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
 * Yes/No answers stored as literal strings `"yes"` / `"no"` in form JSON.
 */
const YES_NO_STRING_TO_PDF_CHECKBOXES: Record<
  string,
  { yes: string; no: string }
> = {
  had_lash_lift_tint: {
    yes: 'prev_lash_lift_yes',
    no: 'prev_lash_lift_no',
  },
  had_brow_lamination_tint: {
    yes: 'prev_brow_lam_yes',
    no: 'prev_brow_lam_no',
  },
  wears_contact_lenses: { yes: 'contacts_yes', no: 'contacts_no' },
  eye_irritation_itching: {
    yes: 'eye_irritation_yes',
    no: 'eye_irritation_no',
  },
  recurring_eye_infections: {
    yes: 'eye_infection_history_yes',
    no: 'eye_infection_history_no',
  },
  currently_eye_drops: { yes: 'eye_drops_yes', no: 'eye_drops_no' },
  pregnant_or_may_be: { yes: 'pregnant_yes', no: 'pregnant_no' },
  eye_injury_or_condition: { yes: 'eye_injury_yes', no: 'eye_injury_no' },
  known_allergies: { yes: 'allergies_yes', no: 'allergies_no' },
  medications_supplements: {
    yes: 'medications_yes',
    no: 'medications_no',
  },
  accutane_last_6_months: { yes: 'accutane_yes', no: 'accutane_no' },
  uses_retinol_tretinoin: { yes: 'retinol_yes', no: 'retinol_no' },
  chemotherapy_recent: { yes: 'chemo_yes', no: 'chemo_no' },
};

/** `medical_conditions_checklist` key → PDF checkbox. */
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

/** `consent_statements` key → PDF policy checkbox. */
const CONSENT_STATEMENT_TO_POLICY: Record<string, string> = {
  beauty_service_risks: 'policy_1',
  eye_contact_protocol: 'policy_2',
  temporary_redness: 'policy_3',
  temporary_staining: 'policy_4',
  color_results_vary: 'policy_5',
  disclosed_health_history: 'policy_6',
  unforeseen_conditions: 'policy_7',
  photo_consent: 'policy_8',
  contact_adverse_reactions: 'policy_9',
  aftercare_understanding: 'policy_10',
  website_policies: 'policy_11',
};

/** Explanation / notes form keys → PDF text fields. */
const EXPLANATION_TEXT_TO_PDF: Record<string, string> = {
  service_adverse_reaction_explain: 'adverse_reaction_explanation',
  pregnancy_weeks: 'pregnant_weeks',
  eye_injury_or_condition_explain: 'eye_injury_explanation',
  known_allergies_explain: 'allergies_explanation',
  medications_supplements_explain: 'medications_explanation',
  chemotherapy_recent_explain: 'chemo_explanation',
  medical_conditions_other_text: 'cond_other_explanation',
  additional_notes: 'additional_notes',
};

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

/** Normalise form yes/no answers (literal `"yes"` / `"no"` strings). */
function parseYesNoString(value: unknown): 'yes' | 'no' | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'yes') return 'yes';
  if (normalised === 'no') return 'no';
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
 * Map a JSON yes/no string to the paired PDF checkboxes for one question.
 */
export function applyYesNoStringToPdf(
  form: PDFForm,
  formKey: string,
  value: unknown
): void {
  const targets = YES_NO_STRING_TO_PDF_CHECKBOXES[formKey];
  if (!targets) return;

  const answer = parseYesNoString(value);
  if (answer === 'yes') {
    tryCheckField(form, targets.yes);
  } else if (answer === 'no') {
    tryCheckField(form, targets.no);
  }
}

function applyBooleanCheckbox(form: PDFForm, fieldName: string, value: unknown): void {
  if (value === true) {
    tryCheckField(form, fieldName);
  }
}

function applyCoreTextFields(form: PDFForm, formData: ConsentFormData): void {
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
  for (const formKey of Object.keys(YES_NO_STRING_TO_PDF_CHECKBOXES)) {
    applyYesNoStringToPdf(form, formKey, formData[formKey]);
  }
}

function applyExplanationFields(form: PDFForm, formData: ConsentFormData): void {
  for (const [formKey, pdfField] of Object.entries(EXPLANATION_TEXT_TO_PDF)) {
    const text = stringValue(formData[formKey]);
    if (text) {
      trySetTextField(form, pdfField, text);
    }
  }
}

function applyMedicalConditions(form: PDFForm, formData: ConsentFormData): void {
  const checklist = formData.medical_conditions_checklist;
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) {
    return;
  }

  const map = checklist as Record<string, unknown>;
  for (const [formKey, pdfField] of Object.entries(MEDICAL_CONDITION_TO_PDF)) {
    applyBooleanCheckbox(form, pdfField, map[formKey]);
  }
}

function applyConsentPolicies(form: PDFForm, formData: ConsentFormData): void {
  const statements = formData.consent_statements;
  if (!statements || typeof statements !== 'object' || Array.isArray(statements)) {
    return;
  }

  const map = statements as Record<string, unknown>;
  for (const [formKey, pdfField] of Object.entries(CONSENT_STATEMENT_TO_POLICY)) {
    applyBooleanCheckbox(form, pdfField, map[formKey]);
  }
}

/**
 * Map submitted intake JSON to Sejda AcroForm field names.
 */
export function applyFormDataToPdf(form: PDFForm, formData: ConsentFormData): void {
  applyCoreTextFields(form, formData);
  applyYesNoFields(form, formData);
  applyMedicalConditions(form, formData);
  applyConsentPolicies(form, formData);
  applyExplanationFields(form, formData);
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
