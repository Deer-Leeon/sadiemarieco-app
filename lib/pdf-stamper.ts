/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 */
import { put } from '@vercel/blob';
import { PDFCheckBox, PDFDocument, StandardFonts, type PDFForm } from 'pdf-lib';
import { sql } from '@vercel/postgres';

import type { ConsentFormData } from '@/lib/consent';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

const SIGNATURE_X = 70;
const SIGNATURE_Y = 310;
const SIGNATURE_WIDTH = 200;
const SIGNATURE_HEIGHT = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. Add it to .env.local from Vercel → Storage → your Blob store → .env.local, then restart the dev server.'
    );
  }
  return token;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function yesNoValue(formData: ConsentFormData, key: string): string {
  const raw = formData[key];
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

type MedicalChecklist = Record<string, boolean | undefined>;
type ConsentPolicies = Record<string, boolean | undefined>;

function createFormHelpers(form: PDFForm) {
  const fieldNames = new Set(form.getFields().map((f) => f.getName()));
  const skipped: string[] = [];

  const recordSkip = (name: string) => {
    skipped.push(name);
  };

  const hasField = (name: string) => fieldNames.has(name);

  const safelyCheckBox = (fieldName: string) => {
    if (!hasField(fieldName)) {
      recordSkip(fieldName);
      return;
    }
    try {
      form.getCheckBox(fieldName).check();
    } catch {
      recordSkip(fieldName);
    }
  };

  const safelySetText = (fieldName: string, text: string) => {
    if (!text) return;
    if (!hasField(fieldName)) {
      recordSkip(fieldName);
      return;
    }
    try {
      form.getTextField(fieldName).setText(text);
    } catch {
      recordSkip(fieldName);
    }
  };

  const applyYesNo = (value: string, yesField: string, noField: string) => {
    if (value === 'yes') {
      safelyCheckBox(yesField);
    } else if (value === 'no') {
      safelyCheckBox(noField);
    }
  };

  return { safelyCheckBox, safelySetText, applyYesNo, skipped, fieldNames };
}

/**
 * Map submitted intake JSON onto whatever AcroForm fields exist in the template.
 * Missing fields are skipped (logged once per stamp, not per field).
 */
export function applyFormDataToPdf(form: PDFForm, formData: ConsentFormData): string[] {
  const { safelyCheckBox, safelySetText, applyYesNo, skipped } =
    createFormHelpers(form);

  const printName =
    stringValue(formData.agreement_print_name) ||
    stringValue(formData.full_name);

  safelySetText('client_name', printName);
  safelySetText('signature_print_name', printName);
  safelySetText('signature_date', stringValue(formData.agreement_date));
  safelySetText('dob', stringValue(formData.dob));
  safelySetText('phone', stringValue(formData.phone));
  safelySetText('address', stringValue(formData.address));
  safelySetText('city', stringValue(formData.city));
  safelySetText('state', stringValue(formData.state));
  safelySetText('zip', stringValue(formData.zip));
  safelySetText('email', stringValue(formData.email));
  safelySetText('occupation', stringValue(formData.occupation));
  safelySetText('referral_source', stringValue(formData.referral_source));
  safelySetText(
    'emergency_contact_name',
    stringValue(formData.emergency_contact_name)
  );
  safelySetText(
    'emergency_contact_phone',
    stringValue(formData.emergency_contact_phone)
  );

  safelySetText(
    'adverse_reaction_explanation',
    stringValue(formData.service_adverse_reaction_explain)
  );
  safelySetText('pregnant_weeks', stringValue(formData.pregnancy_weeks));
  safelySetText(
    'eye_injury_explanation',
    stringValue(formData.eye_injury_or_condition_explain)
  );
  safelySetText(
    'allergies_explanation',
    stringValue(formData.known_allergies_explain)
  );
  safelySetText(
    'medications_explanation',
    stringValue(formData.medications_supplements_explain)
  );
  safelySetText(
    'chemo_explanation',
    stringValue(formData.chemotherapy_recent_explain)
  );
  safelySetText(
    'cond_other_explanation',
    stringValue(formData.medical_conditions_other_text)
  );
  safelySetText('additional_notes', stringValue(formData.additional_notes));

  applyYesNo(
    yesNoValue(formData, 'wears_contact_lenses'),
    'contacts_yes',
    'contacts_no'
  );
  applyYesNo(
    yesNoValue(formData, 'eye_irritation_itching'),
    'eye_irritation_yes',
    'eye_irritation_no'
  );
  applyYesNo(
    yesNoValue(formData, 'recurring_eye_infections'),
    'eye_infection_history_yes',
    'eye_infection_history_no'
  );
  applyYesNo(
    yesNoValue(formData, 'currently_eye_drops'),
    'eye_drops_yes',
    'eye_drops_no'
  );
  applyYesNo(
    yesNoValue(formData, 'pregnant_or_may_be'),
    'pregnant_yes',
    'pregnant_no'
  );
  applyYesNo(
    yesNoValue(formData, 'eye_injury_or_condition'),
    'eye_injury_yes',
    'eye_injury_no'
  );
  applyYesNo(
    yesNoValue(formData, 'known_allergies'),
    'allergies_yes',
    'allergies_no'
  );
  applyYesNo(
    yesNoValue(formData, 'medications_supplements'),
    'medications_yes',
    'medications_no'
  );
  applyYesNo(
    yesNoValue(formData, 'accutane_last_6_months'),
    'accutane_yes',
    'accutane_no'
  );
  applyYesNo(
    yesNoValue(formData, 'uses_retinol_tretinoin'),
    'retinol_yes',
    'retinol_no'
  );
  applyYesNo(
    yesNoValue(formData, 'chemotherapy_recent'),
    'chemo_yes',
    'chemo_no'
  );
  applyYesNo(
    yesNoValue(formData, 'had_lash_lift_tint'),
    'prev_lash_lift_yes',
    'prev_lash_lift_no'
  );
  applyYesNo(
    yesNoValue(formData, 'had_brow_lamination_tint'),
    'prev_brow_lam_yes',
    'prev_brow_lam_no'
  );

  const rawMeds = formData.medical_conditions_checklist;
  const meds: MedicalChecklist =
    rawMeds && typeof rawMeds === 'object' && !Array.isArray(rawMeds)
      ? (rawMeds as MedicalChecklist)
      : {};

  if (meds.alopecia) safelyCheckBox('cond_alopecia');
  if (meds.conjunctivitis) safelyCheckBox('cond_conjunctivitis');
  if (meds.eczema) safelyCheckBox('cond_eczema');
  if (meds.psoriasis_near_eyes) safelyCheckBox('cond_psoriasis');
  if (meds.sensitive_eyes) safelyCheckBox('cond_sensitive_eyes');
  if (meds.cancer) safelyCheckBox('cond_cancer');
  if (meds.diabetes) safelyCheckBox('cond_diabetes');
  if (meds.glaucoma) safelyCheckBox('cond_glaucoma');
  if (meds.thyroid_disease) safelyCheckBox('cond_thyroid');
  if (meds.cataracts) safelyCheckBox('cond_cataracts');
  if (meds.dry_eyes) safelyCheckBox('cond_dry_eyes');
  if (meds.lupus) safelyCheckBox('cond_lupus');
  if (meds.recent_eye_infection) safelyCheckBox('cond_recent_infection');
  if (meds.other) safelyCheckBox('cond_other');

  const rawPolicies = formData.consent_statements;
  const policies: ConsentPolicies =
    rawPolicies &&
    typeof rawPolicies === 'object' &&
    !Array.isArray(rawPolicies)
      ? (rawPolicies as ConsentPolicies)
      : {};

  if (policies.beauty_service_risks) safelyCheckBox('policy_1');
  if (policies.eye_contact_protocol) safelyCheckBox('policy_2');
  if (policies.temporary_redness) safelyCheckBox('policy_3');
  if (policies.temporary_staining) safelyCheckBox('policy_4');
  if (policies.color_results_vary) safelyCheckBox('policy_5');
  if (policies.disclosed_health_history) safelyCheckBox('policy_6');
  if (policies.unforeseen_conditions) safelyCheckBox('policy_7');
  if (policies.photo_consent) safelyCheckBox('policy_8');
  if (policies.contact_adverse_reactions) safelyCheckBox('policy_9');
  if (policies.aftercare_understanding) safelyCheckBox('policy_10');
  if (policies.website_policies) safelyCheckBox('policy_11');

  return [...new Set(skipped)];
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

/** Regenerate appearance streams for checked boxes before flatten bakes them in. */
function refreshCheckedCheckboxAppearances(form: PDFForm): void {
  for (const field of form.getFields()) {
    if (!(field instanceof PDFCheckBox) || !field.isChecked()) continue;
    try {
      field.defaultUpdateAppearances();
    } catch {
      // Template may lack appearance dicts; flatten uses whatever exists.
    }
  }
}

/**
 * Bake form values into the page and remove all AcroForm fields so the signed
 * PDF is not fillable or editable in Preview/Chrome/Acrobat (read-only document).
 */
async function finalizeFormAppearance(
  pdfDoc: PDFDocument,
  form: PDFForm
): Promise<void> {
  refreshCheckedCheckboxAppearances(form);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  try {
    form.updateFieldAppearances(font);
  } catch (err) {
    console.warn('[pdf-stamper] updateFieldAppearances failed:', errorMessage(err));
  }

  try {
    form.flatten({ updateFieldAppearances: false });
  } catch (err) {
    throw new Error(
      `Consent PDF could not be locked (flatten failed): ${errorMessage(err)}`
    );
  }

  const remainingFields = pdfDoc.getForm().getFields();
  if (remainingFields.length > 0) {
    throw new Error(
      `Consent PDF still has ${remainingFields.length} editable field(s) after flatten — refusing to save.`
    );
  }
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

  const skippedFields = applyFormDataToPdf(form, formData);
  if (skippedFields.length > 0) {
    console.warn(
      `[pdf-stamper] ${skippedFields.length} AcroForm field(s) missing from template — re-upload a complete Sejda PDF with all field names. Run: npx tsx --env-file=.env.local scripts/list-consent-pdf-fields.ts`,
      skippedFields.join(', ')
    );
  }

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

  await finalizeFormAppearance(pdfDoc, form);

  const pdfBytes = await pdfDoc.save();
  const token = getBlobToken();

  const pathname = `client-consents/${clientId}-signed.pdf`;
  try {
    const blob = await put(pathname, Buffer.from(pdfBytes), {
      access: 'public',
      contentType: 'application/pdf',
      allowOverwrite: true,
      token,
    });
    return blob.url;
  } catch (err) {
    const message = errorMessage(err);
    console.error('[pdf-stamper] blob put failed:', message);
    if (/access denied|unauthorized|invalid token/i.test(message)) {
      throw new Error(
        'Vercel Blob rejected the upload (invalid BLOB_READ_WRITE_TOKEN). Regenerate the token in Vercel → Storage → your store → .env.local, then restart npm run dev.'
      );
    }
    throw new Error(`Failed to upload stamped consent PDF: ${message}`);
  }
}
