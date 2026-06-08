import { isValidEmail } from '@/lib/client-identity';

export type YesNo = '' | 'yes' | 'no';

export type MedicalConditionChecklistKey =
  | 'alopecia'
  | 'conjunctivitis'
  | 'eczema'
  | 'psoriasis'
  | 'dry_sensitive_eyes'
  | 'cancer'
  | 'diabetes'
  | 'glaucoma'
  | 'thyroid'
  | 'cataracts'
  | 'lupus'
  | 'recent_chemo'
  | 'recent_eye_infection'
  | 'frequent_eye_irritation'
  | 'recurring_eye_infections'
  | 'other';

export type ConsentStatementKey =
  | 'inherent_risks'
  | 'saline_flush'
  | 'unforeseen_conditions'
  | 'photo_consent'
  | 'aftercare_instructions'
  | 'website_policies';

export type MedicalConditionsChecklist = Record<MedicalConditionChecklistKey, boolean>;

export type ConsentStatementsMap = Record<ConsentStatementKey, boolean>;

/** Structured intake payload (stored as JSON on `client_intake_forms.form_data`). */
export interface ConsentFormData {
  full_name: string;
  dob: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  occupation: string;
  referral_source: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  had_lash_lift_tint: YesNo;
  had_brow_lamination_tint: YesNo;
  service_adverse_reaction_explain: string;
  wears_contact_lenses: YesNo;
  pregnant_or_may_be: YesNo;
  pregnancy_weeks: string;
  eye_injury_or_condition: YesNo;
  eye_injury_or_condition_explain: string;
  known_allergies: YesNo;
  known_allergies_explain: string;
  accutane_last_6_months: YesNo;
  uses_retinol_tretinoin: YesNo;
  medical_conditions_checklist: MedicalConditionsChecklist;
  medical_conditions_other_text: string;
  additional_notes: string;
  consent_statements: ConsentStatementsMap;
  agreement_print_name: string;
  agreement_date: string;
}

export const MEDICAL_CONDITION_CHECKLIST: {
  key: MedicalConditionChecklistKey;
  label: string;
}[] = [
  { key: 'alopecia', label: 'Alopecia' },
  { key: 'conjunctivitis', label: 'Conjunctivitis (Pink Eye)' },
  { key: 'eczema', label: 'Eczema' },
  { key: 'psoriasis', label: 'Psoriasis' },
  { key: 'dry_sensitive_eyes', label: 'Dry or sensitive eyes' },
  { key: 'cancer', label: 'Cancer' },
  { key: 'diabetes', label: 'Diabetes' },
  { key: 'glaucoma', label: 'Glaucoma' },
  { key: 'thyroid', label: 'Thyroid disease' },
  { key: 'cataracts', label: 'Cataracts' },
  { key: 'lupus', label: 'Lupus' },
  { key: 'recent_chemo', label: 'Recent chemotherapy' },
  { key: 'recent_eye_infection', label: 'Recent eye infection' },
  { key: 'frequent_eye_irritation', label: 'Frequent eye irritation or itching' },
  { key: 'recurring_eye_infections', label: 'Recurring eye or tear duct infections' },
  { key: 'other', label: 'Other' },
];

export const CONSENT_STATEMENTS: {
  key: ConsentStatementKey;
  text: string;
}[] = [
  {
    key: 'inherent_risks',
    text: 'I understand that beauty services involving the eye area carry inherent risks, including irritation to the skin or eyes, stinging, burning, blurred vision, temporary redness or staining, and that color results may vary. I certify that I have disclosed all relevant medical conditions, medications, allergies, and prior reactions that may affect my service.',
  },
  {
    key: 'saline_flush',
    text: 'I understand that if any product comes into contact with my eyes, the area will be flushed with saline solution and medical attention may be recommended.',
  },
  {
    key: 'unforeseen_conditions',
    text: 'I understand that unforeseen conditions or sensitivities may arise during the procedure that could affect my ability to continue treatment safely.',
  },
  {
    key: 'photo_consent',
    text: 'I consent to before-and-after photographs being taken for documentation, marketing, advertising, and promotional use.',
  },
  {
    key: 'aftercare_instructions',
    text: 'I understand the aftercare instructions provided, acknowledge that failure to follow them may affect my results, and agree to contact my technician promptly if I experience any adverse reactions or concerns following my service.',
  },
  {
    key: 'website_policies',
    text: 'I acknowledge that I have read and understand the policies listed on sadiemarie.co.',
  },
];

export const CLIENT_AGREEMENT_TEXT =
  'By signing below, I confirm that the information provided in this form is accurate and complete to the best of my knowledge. I agree to notify my technician of any changes to my health history or medications prior to future appointments.\n\nI acknowledge that I do not have any condition that would make the requested service unsuitable for me. I understand that I should communicate any discomfort experienced during the procedure so adjustments may be made as needed.\n\nI voluntarily release and waive liability against my technician and business for any injury, reaction, or complication resulting from inaccurate or incomplete health information provided by me.\n\nThis consent agreement will remain valid for all future appointments unless updated or revoked in writing. I confirm that I am at least 18 years of age and consent to receiving lash and/or brow services.';

export const EMPTY_MEDICAL_CHECKLIST: MedicalConditionsChecklist = {
  alopecia: false,
  conjunctivitis: false,
  eczema: false,
  psoriasis: false,
  dry_sensitive_eyes: false,
  cancer: false,
  diabetes: false,
  glaucoma: false,
  thyroid: false,
  cataracts: false,
  lupus: false,
  recent_chemo: false,
  recent_eye_infection: false,
  frequent_eye_irritation: false,
  recurring_eye_infections: false,
  other: false,
};

export const EMPTY_CONSENT_STATEMENTS: ConsentStatementsMap = {
  inherent_risks: false,
  saline_flush: false,
  unforeseen_conditions: false,
  photo_consent: false,
  aftercare_instructions: false,
  website_policies: false,
};

export const INITIAL_FORM: ConsentFormData = {
  full_name: '',
  dob: '',
  phone: '',
  address: '',
  city: '',
  state: '',
  zip: '',
  email: '',
  occupation: '',
  referral_source: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  had_lash_lift_tint: '',
  had_brow_lamination_tint: '',
  service_adverse_reaction_explain: '',
  wears_contact_lenses: '',
  pregnant_or_may_be: '',
  pregnancy_weeks: '',
  eye_injury_or_condition: '',
  eye_injury_or_condition_explain: '',
  known_allergies: '',
  known_allergies_explain: '',
  accutane_last_6_months: '',
  uses_retinol_tretinoin: '',
  medical_conditions_checklist: { ...EMPTY_MEDICAL_CHECKLIST },
  medical_conditions_other_text: '',
  additional_notes: '',
  consent_statements: { ...EMPTY_CONSENT_STATEMENTS },
  agreement_print_name: '',
  agreement_date: '',
};

const LEGACY_MEDICAL_KEY_MAP: Record<string, MedicalConditionChecklistKey> = {
  psoriasis_near_eyes: 'psoriasis',
  sensitive_eyes: 'dry_sensitive_eyes',
  dry_eyes: 'dry_sensitive_eyes',
  thyroid_disease: 'thyroid',
};

const LEGACY_CONSENT_KEY_MAP: Record<string, ConsentStatementKey> = {
  beauty_service_risks: 'inherent_risks',
  eye_contact_protocol: 'saline_flush',
  temporary_redness: 'inherent_risks',
  temporary_staining: 'inherent_risks',
  color_results_vary: 'inherent_risks',
  disclosed_health_history: 'inherent_risks',
  contact_adverse_reactions: 'aftercare_instructions',
  aftercare_understanding: 'aftercare_instructions',
};

export function asYesNo(value: unknown): YesNo {
  if (value === 'yes' || value === 'no') return value;
  return '';
}

export function asMedicalChecklist(value: unknown): MedicalConditionsChecklist {
  const base = { ...EMPTY_MEDICAL_CHECKLIST };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;

  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(base) as MedicalConditionChecklistKey[]) {
    if (key in raw) base[key] = Boolean(raw[key]);
  }
  for (const [legacy, target] of Object.entries(LEGACY_MEDICAL_KEY_MAP)) {
    if (raw[legacy]) base[target] = true;
  }
  if (raw.chemotherapy_recent === 'yes' || raw.chemotherapy_recent === true) {
    base.recent_chemo = true;
  }
  if (raw.eye_irritation_itching === 'yes') base.frequent_eye_irritation = true;
  if (raw.recurring_eye_infections === 'yes') base.recurring_eye_infections = true;

  return base;
}

export function asConsentStatements(value: unknown): ConsentStatementsMap {
  const base = { ...EMPTY_CONSENT_STATEMENTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;

  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(base) as ConsentStatementKey[]) {
    if (key in raw) base[key] = Boolean(raw[key]);
  }
  for (const [legacy, target] of Object.entries(LEGACY_CONSENT_KEY_MAP)) {
    if (raw[legacy]) base[target] = true;
  }

  return base;
}

export function asConsentFormData(value: unknown): ConsentFormData {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...INITIAL_FORM,
    ...raw,
    medical_conditions_checklist: asMedicalChecklist(raw.medical_conditions_checklist),
    consent_statements: asConsentStatements(raw.consent_statements),
    had_lash_lift_tint: asYesNo(raw.had_lash_lift_tint),
    had_brow_lamination_tint: asYesNo(raw.had_brow_lamination_tint),
    wears_contact_lenses: asYesNo(raw.wears_contact_lenses),
    pregnant_or_may_be: asYesNo(raw.pregnant_or_may_be),
    eye_injury_or_condition: asYesNo(raw.eye_injury_or_condition),
    known_allergies: asYesNo(raw.known_allergies),
    accutane_last_6_months: asYesNo(raw.accutane_last_6_months),
    uses_retinol_tretinoin: asYesNo(raw.uses_retinol_tretinoin),
  };
}

export function allConsentStatementsAccepted(statements: ConsentStatementsMap): boolean {
  return CONSENT_STATEMENTS.every((s) => statements[s.key]);
}

export function isYesNoAnswered(value: YesNo): boolean {
  return value === 'yes' || value === 'no';
}

export function validateConsentForm(form: ConsentFormData): string | null {
  const req = (label: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return `${label} is required.`;
    return null;
  };

  for (const field of [
    ['Full name', form.full_name],
    ['Date of birth', form.dob],
    ['Phone number', form.phone],
    ['Address', form.address],
    ['City', form.city],
    ['State', form.state],
    ['Zip', form.zip],
    ['Email address', form.email],
    ['Emergency contact name', form.emergency_contact_name],
    ['Emergency contact phone', form.emergency_contact_phone],
    ['Printed name', form.agreement_print_name],
  ] as const) {
    const err = req(field[0], field[1]);
    if (err) return err;
  }
  if (!isValidEmail(form.email)) {
    return 'Enter a valid email address.';
  }

  const lash = asYesNo(form.had_lash_lift_tint);
  const brow = asYesNo(form.had_brow_lamination_tint);
  if (!isYesNoAnswered(lash)) return 'Please answer whether you have had a lash lift and/or tint.';
  if (!isYesNoAnswered(brow)) {
    return 'Please answer whether you have had a brow lamination and/or tint.';
  }
  if (
    (lash === 'yes' || brow === 'yes') &&
    !String(form.service_adverse_reaction_explain ?? '').trim()
  ) {
    return 'Please explain any prior adverse reactions to lash or brow services.';
  }

  if (!isYesNoAnswered(asYesNo(form.wears_contact_lenses))) {
    return 'Please answer the question about contact lenses.';
  }
  if (!isYesNoAnswered(asYesNo(form.pregnant_or_may_be))) {
    return 'Please answer the question about pregnancy.';
  }
  if (asYesNo(form.pregnant_or_may_be) === 'yes' && !String(form.pregnancy_weeks ?? '').trim()) {
    return 'Please indicate how far along you are in your pregnancy.';
  }

  const personalYesNo: [string, YesNo, string | undefined][] = [
    [
      'eye injury or condition',
      asYesNo(form.eye_injury_or_condition),
      form.eye_injury_or_condition_explain,
    ],
    ['allergies', asYesNo(form.known_allergies), form.known_allergies_explain],
    ['Accutane use', asYesNo(form.accutane_last_6_months), undefined],
    ['retinol or tretinoin', asYesNo(form.uses_retinol_tretinoin), undefined],
  ];
  for (const [label, val, explain] of personalYesNo) {
    if (!isYesNoAnswered(val)) return `Please answer the medical question about ${label}.`;
    if (val === 'yes' && explain !== undefined && !String(explain ?? '').trim()) {
      return `Please provide details for: ${label}.`;
    }
  }

  const checklist = asMedicalChecklist(form.medical_conditions_checklist);
  if (checklist.other && !String(form.medical_conditions_other_text ?? '').trim()) {
    return 'Please describe the “Other” medical condition you checked.';
  }

  const statements = asConsentStatements(form.consent_statements);
  if (!allConsentStatementsAccepted(statements)) {
    return 'Please read and check every consent statement before submitting.';
  }

  if (!String(form.agreement_date ?? '').trim()) {
    return 'Date is required.';
  }

  return null;
}

export function buildInitialForm(client: {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
}): ConsentFormData {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...INITIAL_FORM,
    full_name: [client.first_name, client.last_name].filter(Boolean).join(' '),
    phone: client.phone ?? '',
    email: client.email ?? '',
    agreement_print_name: [client.first_name, client.last_name].filter(Boolean).join(' '),
    agreement_date: today,
    medical_conditions_checklist: { ...EMPTY_MEDICAL_CHECKLIST },
    consent_statements: { ...EMPTY_CONSENT_STATEMENTS },
  };
}

export const SERVICE_HISTORY_QUESTIONS: { key: keyof ConsentFormData; label: string }[] = [
  { key: 'had_lash_lift_tint', label: 'Previously had lash lift and/or tint' },
  { key: 'had_brow_lamination_tint', label: 'Previously had brow lamination and/or tint' },
];

export const PERSONAL_INFO_QUESTIONS: {
  key: keyof ConsentFormData;
  label: string;
  explainKey?: keyof ConsentFormData;
}[] = [
  { key: 'wears_contact_lenses', label: 'Wears contact lenses' },
  {
    key: 'pregnant_or_may_be',
    label: 'Pregnant or may be pregnant',
    explainKey: 'pregnancy_weeks',
  },
  {
    key: 'eye_injury_or_condition',
    label: 'Eye injury or condition being treated',
    explainKey: 'eye_injury_or_condition_explain',
  },
  {
    key: 'known_allergies',
    label: 'Known allergies',
    explainKey: 'known_allergies_explain',
  },
  { key: 'accutane_last_6_months', label: 'Accutane within last 6 months' },
  { key: 'uses_retinol_tretinoin', label: 'Uses retinol or tretinoin' },
];
