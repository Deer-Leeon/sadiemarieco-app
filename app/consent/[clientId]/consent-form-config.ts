import type { ConsentApiResponse, ConsentFormData } from '@/lib/consent';

export type YesNo = '' | 'yes' | 'no';

export type MedicalConditionChecklistKey =
  | 'alopecia'
  | 'conjunctivitis'
  | 'eczema'
  | 'psoriasis_near_eyes'
  | 'sensitive_eyes'
  | 'cancer'
  | 'diabetes'
  | 'glaucoma'
  | 'thyroid_disease'
  | 'cataracts'
  | 'dry_eyes'
  | 'lupus'
  | 'recent_eye_infection'
  | 'other';

export type ConsentStatementKey =
  | 'beauty_service_risks'
  | 'eye_contact_protocol'
  | 'temporary_redness'
  | 'temporary_staining'
  | 'color_results_vary'
  | 'disclosed_health_history'
  | 'unforeseen_conditions'
  | 'photo_consent'
  | 'contact_adverse_reactions'
  | 'aftercare_understanding'
  | 'website_policies';

export type MedicalConditionsChecklist = Record<MedicalConditionChecklistKey, boolean>;

export type ConsentStatementsMap = Record<ConsentStatementKey, boolean>;

export const MEDICAL_CONDITION_CHECKLIST: {
  key: MedicalConditionChecklistKey;
  label: string;
}[] = [
  { key: 'alopecia', label: 'Alopecia' },
  { key: 'conjunctivitis', label: 'Conjunctivitis (Pink Eye)' },
  { key: 'eczema', label: 'Eczema' },
  { key: 'psoriasis_near_eyes', label: 'Psoriasis near the eyes' },
  { key: 'sensitive_eyes', label: 'Sensitive eyes' },
  { key: 'cancer', label: 'Cancer' },
  { key: 'diabetes', label: 'Diabetes' },
  { key: 'glaucoma', label: 'Glaucoma' },
  { key: 'thyroid_disease', label: 'Thyroid Disease' },
  { key: 'cataracts', label: 'Cataracts' },
  { key: 'dry_eyes', label: 'Dry eyes' },
  { key: 'lupus', label: 'Lupus' },
  { key: 'recent_eye_infection', label: 'Recent eye infection' },
  { key: 'other', label: 'Other' },
];

export const CONSENT_STATEMENTS: {
  key: ConsentStatementKey;
  text: string;
}[] = [
  {
    key: 'beauty_service_risks',
    text: 'I understand that beauty services involving the eye area may carry certain inherent risks, including irritation to the skin or eyes, stinging, burning, blurred vision, or other complications if products accidentally enter the eye.',
  },
  {
    key: 'eye_contact_protocol',
    text: 'I understand that if any product comes into contact with my eyes, the area will be flushed with saline solution and medical attention may be recommended.',
  },
  {
    key: 'temporary_redness',
    text: 'I understand that temporary redness, itching, irritation, or sensitivity may occur in areas where products are applied.',
  },
  {
    key: 'temporary_staining',
    text: 'I understand that temporary staining of the skin may occur following lash or brow tinting services and should fade within a short period of time.',
  },
  {
    key: 'color_results_vary',
    text: 'I understand that while every effort will be made to achieve my desired color results, individual hair texture and porosity may affect the final outcome.',
  },
  {
    key: 'disclosed_health_history',
    text: 'I certify that I have disclosed all relevant medical conditions, medications, allergies, and prior reactions that may affect my service.',
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
    key: 'contact_adverse_reactions',
    text: 'I agree to contact my technician promptly if I experience any adverse reactions or concerns following my service.',
  },
  {
    key: 'aftercare_understanding',
    text: 'I understand the aftercare instructions provided and acknowledge that failure to follow them may affect my results and overall experience.',
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
  psoriasis_near_eyes: false,
  sensitive_eyes: false,
  cancer: false,
  diabetes: false,
  glaucoma: false,
  thyroid_disease: false,
  cataracts: false,
  dry_eyes: false,
  lupus: false,
  recent_eye_infection: false,
  other: false,
};

export const EMPTY_CONSENT_STATEMENTS: ConsentStatementsMap = {
  beauty_service_risks: false,
  eye_contact_protocol: false,
  temporary_redness: false,
  temporary_staining: false,
  color_results_vary: false,
  disclosed_health_history: false,
  unforeseen_conditions: false,
  photo_consent: false,
  contact_adverse_reactions: false,
  aftercare_understanding: false,
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
  eye_irritation_itching: '',
  recurring_eye_infections: '',
  currently_eye_drops: '',
  pregnant_or_may_be: '',
  pregnancy_weeks: '',
  eye_injury_or_condition: '',
  eye_injury_or_condition_explain: '',
  known_allergies: '',
  known_allergies_explain: '',
  medications_supplements: '',
  medications_supplements_explain: '',
  accutane_last_6_months: '',
  uses_retinol_tretinoin: '',
  chemotherapy_recent: '',
  chemotherapy_recent_explain: '',
  medical_conditions_checklist: { ...EMPTY_MEDICAL_CHECKLIST },
  medical_conditions_other_text: '',
  additional_notes: '',
  consent_statements: { ...EMPTY_CONSENT_STATEMENTS },
  agreement_print_name: '',
  agreement_date: '',
};

export function asYesNo(value: unknown): YesNo {
  if (value === 'yes' || value === 'no') return value;
  return '';
}

export function asMedicalChecklist(value: unknown): MedicalConditionsChecklist {
  const base = { ...EMPTY_MEDICAL_CHECKLIST };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const key of Object.keys(base) as MedicalConditionChecklistKey[]) {
    if (key in value) {
      base[key] = Boolean((value as MedicalConditionsChecklist)[key]);
    }
  }
  return base;
}

export function asConsentStatements(value: unknown): ConsentStatementsMap {
  const base = { ...EMPTY_CONSENT_STATEMENTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const key of Object.keys(base) as ConsentStatementKey[]) {
    if (key in value) base[key] = Boolean((value as ConsentStatementsMap)[key]);
  }
  return base;
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

  const personalFields: [string, YesNo][] = [
    ['contact lenses', asYesNo(form.wears_contact_lenses)],
    ['eye irritation', asYesNo(form.eye_irritation_itching)],
    ['recurring eye infections', asYesNo(form.recurring_eye_infections)],
    ['eye drops', asYesNo(form.currently_eye_drops)],
    ['pregnancy', asYesNo(form.pregnant_or_may_be)],
  ];
  for (const [label, val] of personalFields) {
    if (!isYesNoAnswered(val)) return `Please answer the question about ${label}.`;
  }
  if (asYesNo(form.pregnant_or_may_be) === 'yes' && !String(form.pregnancy_weeks ?? '').trim()) {
    return 'Please indicate how far along you are in your pregnancy.';
  }

  const medicalYesNo: [string, YesNo, string | undefined][] = [
    ['eye injury or condition', asYesNo(form.eye_injury_or_condition), form.eye_injury_or_condition_explain as string | undefined],
    ['allergies', asYesNo(form.known_allergies), form.known_allergies_explain as string | undefined],
    ['medications or supplements', asYesNo(form.medications_supplements), form.medications_supplements_explain as string | undefined],
    ['Accutane use', asYesNo(form.accutane_last_6_months), undefined],
    ['retinol or tretinoin', asYesNo(form.uses_retinol_tretinoin), undefined],
    ['chemotherapy', asYesNo(form.chemotherapy_recent), form.chemotherapy_recent_explain as string | undefined],
  ];
  for (const [label, val, explain] of medicalYesNo) {
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

export function buildInitialForm(client: ConsentApiResponse['client']): ConsentFormData {
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

export const SERVICE_HISTORY_QUESTIONS: { key: string; label: string }[] = [
  { key: 'had_lash_lift_tint', label: 'Previously had lash lift and/or tint' },
  { key: 'had_brow_lamination_tint', label: 'Previously had brow lamination and/or tint' },
];

export const PERSONAL_INFO_QUESTIONS: { key: string; label: string }[] = [
  { key: 'wears_contact_lenses', label: 'Wears contact lenses' },
  { key: 'eye_irritation_itching', label: 'Frequent eye irritation or itching' },
  { key: 'recurring_eye_infections', label: 'Recurring eye or tear duct infections' },
  { key: 'currently_eye_drops', label: 'Currently uses eye drops' },
  { key: 'pregnant_or_may_be', label: 'Pregnant or may be pregnant' },
];

export const MEDICAL_HISTORY_QUESTIONS: {
  key: string;
  label: string;
  explainKey?: string;
}[] = [
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
  {
    key: 'medications_supplements',
    label: 'Taking medications or supplements',
    explainKey: 'medications_supplements_explain',
  },
  { key: 'accutane_last_6_months', label: 'Accutane within last 6 months' },
  { key: 'uses_retinol_tretinoin', label: 'Uses retinol or tretinoin' },
  {
    key: 'chemotherapy_recent',
    label: 'Recent chemotherapy',
    explainKey: 'chemotherapy_recent_explain',
  },
];
