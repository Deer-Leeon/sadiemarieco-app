/**
 * Stamp client intake answers + signature onto the studio PDF template,
 * upload the flattened PDF to Vercel Blob, and return the public URL.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import fontkit from '@pdf-lib/fontkit';
import { put } from '@vercel/blob';
import {
  adjustDimsForRotation,
  drawCheckMark,
  PDFCheckBox,
  PDFDocument,
  PDFTextField,
  reduceRotation,
  rotateInPlace,
  rgb,
  type AppearanceProviderFor,
  type PDFFont,
  type PDFForm,
  type PDFDict,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { sql } from '@vercel/postgres';

import { asConsentFormData } from '@/app/consent/[clientId]/consent-form-config';
import type { ConsentFormData } from '@/lib/consent';
import {
  fitImageDimensions,
  placeImageInBox,
  signaturePlacementBox,
} from '@/lib/signature-fit';
import { STUDIO_SETTINGS_ROW_ID } from '@/lib/studio-settings';

/** Stamped field text + checkmarks (brand navy). */
const STAMP_TEXT_COLOR = rgb(13 / 255, 27 / 255, 42 / 255);

const EB_GARAMOND_FONT_CANDIDATES = [
  join(process.cwd(), 'public/fonts/EBGaramond-Regular.ttf'),
  join(process.cwd(), 'assets/fonts/EBGaramond-Regular.ttf'),
];

/** Readable size for single-line answers on the Sejda template. */
const STAMP_FONT_SIZE = 11;

const MIN_STAMP_FONT_SIZE = 10;
const MAX_STAMP_FONT_SIZE = 14;

const DA_FONT_SIZE_PATTERN = /\/[^\s]+\s+(\d+(?:\.\d+)?)\s+Tf/g;

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

function yesNoValue(
  formData: ConsentFormData,
  key: keyof ConsentFormData
): string {
  const raw = formData[key];
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

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
  const { safelyCheckBox, safelySetText, skipped } = createFormHelpers(form);

  // --- TEXT FIELDS ---
  safelySetText('client_name', stringValue(formData.full_name));
  safelySetText('signature_print_name', stringValue(formData.full_name));
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
    'cond_other_explanation',
    stringValue(formData.medical_conditions_other_text)
  );
  safelySetText('additional_notes', stringValue(formData.additional_notes));

  // --- YES/NO STRINGS ---
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
  if (yesNoValue(formData, 'wears_contact_lenses') === 'yes') {
    safelyCheckBox('contacts_yes');
  }
  if (yesNoValue(formData, 'wears_contact_lenses') === 'no') {
    safelyCheckBox('contacts_no');
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

  const rawMeds = formData.medical_conditions_checklist;
  const meds =
    rawMeds && typeof rawMeds === 'object' && !Array.isArray(rawMeds)
      ? (rawMeds as Record<string, boolean | undefined>)
      : {};

  // --- MEDICAL CONDITIONS (BOOLEANS) ---
  if (meds.alopecia) safelyCheckBox('cond_alopecia');
  if (meds.conjunctivitis) safelyCheckBox('cond_conjunctivitis');
  if (meds.eczema) safelyCheckBox('cond_eczema');
  if (meds.psoriasis || meds.psoriasis_near_eyes) safelyCheckBox('cond_psoriasis');
  if (meds.dry_sensitive_eyes || meds.sensitive_eyes || meds.dry_eyes) {
    safelyCheckBox('cond_dry_sensitive');
  }
  if (meds.cancer) safelyCheckBox('cond_cancer');
  if (meds.diabetes) safelyCheckBox('cond_diabetes');
  if (meds.glaucoma) safelyCheckBox('cond_glaucoma');
  if (meds.thyroid || meds.thyroid_disease) safelyCheckBox('cond_thyroid');
  if (meds.cataracts) safelyCheckBox('cond_cataracts');
  if (meds.lupus) safelyCheckBox('cond_lupus');
  if (meds.recent_chemo) safelyCheckBox('cond_chemo');
  if (meds.recent_eye_infection) safelyCheckBox('cond_recent_infection');
  if (meds.frequent_eye_irritation) safelyCheckBox('cond_eye_irritation');
  if (meds.recurring_eye_infections) safelyCheckBox('cond_recurring_infections');
  if (meds.other) safelyCheckBox('cond_other');

  const rawPolicies = formData.consent_statements;
  const policies =
    rawPolicies &&
    typeof rawPolicies === 'object' &&
    !Array.isArray(rawPolicies)
      ? (rawPolicies as Record<string, boolean | undefined>)
      : {};

  // --- POLICIES (BOOLEANS) ---
  if (policies.inherent_risks || policies.beauty_service_risks) {
    safelyCheckBox('policy_1');
  }
  if (policies.saline_flush || policies.eye_contact_protocol) {
    safelyCheckBox('policy_2');
  }
  if (policies.unforeseen_conditions) safelyCheckBox('policy_3');
  if (policies.photo_consent) safelyCheckBox('policy_4');
  if (policies.aftercare_instructions || policies.aftercare_understanding) {
    safelyCheckBox('policy_5');
  }
  if (policies.website_policies) safelyCheckBox('policy_6');

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

/**
 * Checked boxes: pdf-lib stroke checkmark only (no widget border).
 * Unchecked: transparent appearance so flatten does not draw an extra box.
 */
const checkMarkOnlyAppearanceProvider: AppearanceProviderFor<PDFCheckBox> = (
  _checkBox,
  widget
) => {
  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const rotate = rotateInPlace({ ...rectangle, rotation });
  const markColor = STAMP_TEXT_COLOR;
  const checkMarkSize = Math.min(width, height) / 2;
  const checked = [
    ...rotate,
    ...drawCheckMark({
      x: width / 2,
      y: height / 2,
      size: checkMarkSize,
      thickness: 1.5,
      color: markColor,
    }),
  ];

  return {
    normal: { on: checked, off: [] },
    down: { on: checked, off: [] },
  };
};

async function loadEbGaramondFontBytes(): Promise<Uint8Array> {
  for (const fontPath of EB_GARAMOND_FONT_CANDIDATES) {
    try {
      return new Uint8Array(await readFile(fontPath));
    } catch {
      // try next path (public/ for Vercel, assets/ for local)
    }
  }
  throw new Error(
    'EB Garamond font file not found. Expected public/fonts/EBGaramond-Regular.ttf'
  );
}

async function embedStampFont(pdfDoc: PDFDocument): Promise<PDFFont> {
  pdfDoc.registerFontkit(fontkit);
  const bytes = await loadEbGaramondFontBytes();
  // Full embed avoids subset metric glitches with form-derived coordinates.
  return pdfDoc.embedFont(bytes, { subset: false });
}

function parseFontSizeFromDefaultAppearance(
  da: string | undefined
): number | undefined {
  if (!da) return undefined;
  const matches = [...da.matchAll(DA_FONT_SIZE_PATTERN)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const size = Number(last[1]);
  if (!Number.isFinite(size) || size <= 0) return undefined;
  return size;
}

function clampStampFontSize(size: number): number {
  return Math.max(MIN_STAMP_FONT_SIZE, Math.min(MAX_STAMP_FONT_SIZE, size));
}

/** Sejda DA often lists 0–1pt; use a stable readable size instead. */
function inferStampFontSize(field: PDFTextField): number {
  if (field.isMultiline()) {
    const widgets = field.acroField.getWidgets();
    if (widgets.length > 0) {
      const { height } = widgets[0].getRectangle();
      if (height > 24) return clampStampFontSize(Math.round(height / 5));
    }
    return 10;
  }

  const widgets = field.acroField.getWidgets();
  const fromWidget =
    widgets.length > 0
      ? parseFontSizeFromDefaultAppearance(widgets[0].getDefaultAppearance())
      : undefined;
  const fromField = parseFontSizeFromDefaultAppearance(
    field.acroField.getDefaultAppearance()
  );
  const fromTemplate = fromWidget ?? fromField;
  if (fromTemplate && fromTemplate >= MIN_STAMP_FONT_SIZE) {
    return clampStampFontSize(fromTemplate);
  }
  return STAMP_FONT_SIZE;
}

/** Prevent flatten from baking broken Sejda text appearances (tiny glyph debris). */
const emptyTextFieldAppearanceProvider: AppearanceProviderFor<PDFTextField> = () => [];

function clearTextFieldAppearancesForFlatten(
  form: PDFForm,
  font: PDFFont
): void {
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    try {
      field.updateAppearances(font, emptyTextFieldAppearanceProvider);
    } catch (err) {
      console.warn(
        `[pdf-stamper] clear text appearance failed (${field.getName()}):`,
        errorMessage(err)
      );
    }
  }
}

type TextFieldPlacement = {
  page: PDFPage;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  maxWidth: number;
};

function findPageForWidget(
  pdfDoc: PDFDocument,
  widget: {
    P(): PDFRef | undefined;
    getRectangle(): { x: number; y: number; width: number; height: number };
    dict: PDFDict;
  }
): PDFPage | undefined {
  const pageRef = widget.P();
  if (pageRef) {
    const page = pdfDoc.getPages().find((p) => p.ref === pageRef);
    if (page) return page;
  }

  const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
  if (widgetRef) {
    return pdfDoc.findPageForAnnotationRef(widgetRef);
  }

  return undefined;
}

/**
 * Place the drawn signature on the dotted line. Uses the same box as the
 * canvas preview (`signaturePlacementBox`) so the stamped PDF matches review.
 */
function resolveSignaturePlacement(
  pdfDoc: PDFDocument,
  form: PDFForm
): { page: PDFPage; x: number; y: number; width: number; height: number } {
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1]!;
  const box = signaturePlacementBox();

  try {
    const dateField = form.getTextField('signature_date');
    for (const widget of dateField.acroField.getWidgets()) {
      const page = findPageForWidget(pdfDoc, widget) ?? lastPage;
      return { page, ...box };
    }
  } catch {
    // Field missing on older templates — use measured fallback.
  }

  return { page: lastPage, ...box };
}

/** Snapshot values + positions before flatten removes AcroForm fields. */
function collectTextFieldPlacements(
  pdfDoc: PDFDocument,
  form: PDFForm
): TextFieldPlacement[] {
  const placements: TextFieldPlacement[] = [];

  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const text = field.getText()?.trim() ?? '';
    if (!text) continue;

    const fontSize = inferStampFontSize(field);
    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      const page = findPageForWidget(pdfDoc, widget);
      if (!page) continue;

      const { x, y, width, height } = widget.getRectangle();
      placements.push({
        page,
        text,
        x: x + 3,
        y: y + Math.max(3, (height - fontSize) / 2 + 1),
        fontSize,
        maxWidth: Math.max(24, width - 6),
      });
    }
  }

  return placements;
}

/** Draw filled answers on the page (reliable vs Sejda AcroForm appearances). */
function drawTextFieldPlacements(
  placements: TextFieldPlacement[],
  font: PDFFont
): void {
  for (const { page, text, x, y, fontSize, maxWidth } of placements) {
    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      color: STAMP_TEXT_COLOR,
      maxWidth,
    });
  }
}

/** Regenerate checkbox appearances before flatten bakes them into the page. */
function refreshCheckboxAppearances(form: PDFForm): void {
  for (const field of form.getFields()) {
    if (!(field instanceof PDFCheckBox)) continue;
    try {
      field.updateAppearances(checkMarkOnlyAppearanceProvider);
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
  const font = await embedStampFont(pdfDoc);
  const textPlacements = collectTextFieldPlacements(pdfDoc, form);
  clearTextFieldAppearancesForFlatten(form, font);
  refreshCheckboxAppearances(form);

  try {
    form.flatten({ updateFieldAppearances: false });
  } catch (err) {
    throw new Error(
      `Consent PDF could not be locked (flatten failed): ${errorMessage(err)}`
    );
  }

  drawTextFieldPlacements(textPlacements, font);

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

function logSkippedFields(skippedFields: string[]): void {
  if (skippedFields.length === 0) return;
  console.warn(
    `[pdf-stamper] ${skippedFields.length} AcroForm field(s) missing from template — re-upload a complete Sejda PDF with all field names. Run: npx tsx --env-file=.env.local scripts/list-consent-pdf-fields.ts`,
    skippedFields.join(', ')
  );
}

/** Load studio template and apply intake field mapping (no signature, no flatten). */
async function loadFilledConsentPdf(
  formData: ConsentFormData
): Promise<PDFDocument> {
  const templateUrl = await loadTemplateUrl();
  const buffer = await fetchTemplatePdfBuffer(templateUrl);
  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();
  const skippedFields = applyFormDataToPdf(form, formData);
  logSkippedFields(skippedFields);
  return pdfDoc;
}

/** Interactive AcroForm preview — checkmarks visible, flatten intentionally skipped. */
async function preparePreviewFormAppearance(
  pdfDoc: PDFDocument,
  form: PDFForm
): Promise<void> {
  refreshCheckboxAppearances(form);
  try {
    const font = await embedStampFont(pdfDoc);
    for (const field of form.getFields()) {
      if (field instanceof PDFTextField) {
        field.updateAppearances(font);
      }
    }
  } catch (err) {
    console.warn(
      '[pdf-stamper] preview text appearance update failed:',
      errorMessage(err)
    );
  }
  // form.flatten() intentionally not called — preview stays an editable AcroForm PDF.
}

/**
 * Build a read-only, flattened preview PDF (no signature, no Blob upload).
 * Flattening removes editable fields so the in-app viewer cannot be filled in.
 */
export async function generateUnsignedPreviewPDF(
  formData: unknown
): Promise<string> {
  const normalized = asConsentFormData(formData);
  const pdfDoc = await loadFilledConsentPdf(normalized);
  const form = pdfDoc.getForm();
  await finalizeFormAppearance(pdfDoc, form);
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString('base64');
}

/**
 * Load the studio template, stamp fields + signature, upload to Blob.
 */
export async function stampConsentPDF(
  clientId: string,
  formData: ConsentFormData,
  signatureBase64: string
): Promise<string> {
  const pdfDoc = await loadFilledConsentPdf(formData);
  const form = pdfDoc.getForm();

  const signatureBytes = parseSignaturePngBytes(signatureBase64);
  const signatureImage = await pdfDoc.embedPng(signatureBytes);
  const placement = resolveSignaturePlacement(pdfDoc, form);
  const fitted = fitImageDimensions(
    signatureImage.width,
    signatureImage.height,
    placement.width,
    placement.height
  );
  const dest = placeImageInBox(placement, fitted, { origin: 'bottom-left' });
  placement.page.drawImage(signatureImage, dest);

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
