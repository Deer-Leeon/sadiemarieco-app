/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 *
 * Field mapping is explicit (no generic loops) so checkboxes always use
 * getCheckBox() and text fields always use getTextField().
 */
import { put } from '@vercel/blob';
import { PDFDocument, type PDFForm } from 'pdf-lib';
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

/**
 * Hardcoded Sejda AcroForm mapping — every field is set explicitly.
 */
export function applyFormDataToPdf(form: PDFForm, formData: ConsentFormData): void {
  const safelyCheckBox = (fieldName: string) => {
    try {
      const field = form.getCheckBox(fieldName);
      field.check();
    } catch (error) {
      console.error(`❌ Checkbox mapping failed for: ${fieldName}`, error);
    }
  };

  const safelySetText = (fieldName: string, text: string) => {
    try {
      if (!text) return;
      const field = form.getTextField(fieldName);
      field.setText(text);
    } catch (error) {
      console.error(`❌ Text mapping failed for: ${fieldName}`, error);
    }
  };

  const printName =
    stringValue(formData.agreement_print_name) ||
    stringValue(formData.full_name);

  // --- TEXT FIELDS ---
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

  // --- EXPLANATION TEXT FIELDS ---
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

  // --- YES/NO STRINGS ---
  if (yesNoValue(formData, 'wears_contact_lenses') === 'yes') {
    safelyCheckBox('contacts_yes');
  }
  if (yesNoValue(formData, 'wears_contact_lenses') === 'no') {
    safelyCheckBox('contacts_no');
  }

  if (yesNoValue(formData, 'eye_irritation_itching') === 'yes') {
    safelyCheckBox('eye_irritation_yes');
  }
  if (yesNoValue(formData, 'eye_irritation_itching') === 'no') {
    safelyCheckBox('eye_irritation_no');
  }

  if (yesNoValue(formData, 'recurring_eye_infections') === 'yes') {
    safelyCheckBox('eye_infection_history_yes');
  }
  if (yesNoValue(formData, 'recurring_eye_infections') === 'no') {
    safelyCheckBox('eye_infection_history_no');
  }

  if (yesNoValue(formData, 'currently_eye_drops') === 'yes') {
    safelyCheckBox('eye_drops_yes');
  }
  if (yesNoValue(formData, 'currently_eye_drops') === 'no') {
    safelyCheckBox('eye_drops_no');
  }

  if (yesNoValue(formData, 'pregnant_or_may_be') === 'yes') {
    safelyCheckBox('pregnant_yes');
  }
  if (yesNoValue(formData, 'pregnant_or_may_be') === 'no') {
    safelyCheckBox('pregnant_no');
  }

  if (yesNoValue(formData, 'eye_injury_or_condition') === 'yes') {
    safelyCheckBox('eye_injury_yes');
  }
  if (yesNoValue(formData, 'eye_injury_or_condition') === 'no') {
    safelyCheckBox('eye_injury_no');
  }

  if (yesNoValue(formData, 'known_allergies') === 'yes') {
    safelyCheckBox('allergies_yes');
  }
  if (yesNoValue(formData, 'known_allergies') === 'no') {
    safelyCheckBox('allergies_no');
  }

  if (yesNoValue(formData, 'medications_supplements') === 'yes') {
    safelyCheckBox('medications_yes');
  }
  if (yesNoValue(formData, 'medications_supplements') === 'no') {
    safelyCheckBox('medications_no');
  }

  if (yesNoValue(formData, 'accutane_last_6_months') === 'yes') {
    safelyCheckBox('accutane_yes');
  }
  if (yesNoValue(formData, 'accutane_last_6_months') === 'no') {
    safelyCheckBox('accutane_no');
  }

  if (yesNoValue(formData, 'uses_retinol_tretinoin') === 'yes') {
    safelyCheckBox('retinol_yes');
  }
  if (yesNoValue(formData, 'uses_retinol_tretinoin') === 'no') {
    safelyCheckBox('retinol_no');
  }

  if (yesNoValue(formData, 'chemotherapy_recent') === 'yes') {
    safelyCheckBox('chemo_yes');
  }
  if (yesNoValue(formData, 'chemotherapy_recent') === 'no') {
    safelyCheckBox('chemo_no');
  }

  if (yesNoValue(formData, 'had_lash_lift_tint') === 'yes') {
    safelyCheckBox('prev_lash_lift_yes');
  }
  if (yesNoValue(formData, 'had_lash_lift_tint') === 'no') {
    safelyCheckBox('prev_lash_lift_no');
  }

  if (yesNoValue(formData, 'had_brow_lamination_tint') === 'yes') {
    safelyCheckBox('prev_brow_lam_yes');
  }
  if (yesNoValue(formData, 'had_brow_lamination_tint') === 'no') {
    safelyCheckBox('prev_brow_lam_no');
  }

  // --- MEDICAL CONDITIONS (BOOLEANS) ---
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

  // --- POLICIES (BOOLEANS) ---
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
