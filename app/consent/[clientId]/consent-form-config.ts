import type { ConsentApiResponse, ConsentFormData } from '@/lib/consent';

export type MedicalConditionKey =
  | 'alopecia'
  | 'eczema'
  | 'trichotillomania'
  | 'allergies'
  | 'pregnant'
  | 'sensitive_eyes'
  | 'contact_lenses';

export type ConsentAgreementKey =
  | 'appointment_policies'
  | 'retention_expectations'
  | 'post_care_compliance'
  | 'model_release_photos';

export type MedicalConditionsMap = Record<MedicalConditionKey, boolean>;
export type ConsentAgreementsMap = Record<ConsentAgreementKey, boolean>;

export const MEDICAL_CONDITION_FIELDS: {
  key: MedicalConditionKey;
  label: string;
}[] = [
  {
    key: 'contact_lenses',
    label: 'Do you wear contact lenses?',
  },
  {
    key: 'sensitive_eyes',
    label: 'Do you have sensitive eyes or a history of eye irritation?',
  },
  {
    key: 'eczema',
    label:
      'History of eczema, psoriasis, or dermatitis around the eyes or brow area?',
  },
  {
    key: 'alopecia',
    label: 'History of alopecia or significant lash/brow hair loss?',
  },
  {
    key: 'trichotillomania',
    label: 'History of trichotillomania or habitual lash/brow picking?',
  },
  {
    key: 'allergies',
    label:
      'Known allergies to adhesives, tints, latex, or cosmetic products?',
  },
  {
    key: 'pregnant',
    label: 'Are you currently pregnant or nursing?',
  },
];

export const CONSENT_POLICY_ITEMS: {
  key: ConsentAgreementKey;
  title: string;
  description: string;
}[] = [
  {
    key: 'appointment_policies',
    title: 'Appointment & cancellation policy',
    description:
      'I understand that appointments require at least 24 hours’ notice to reschedule or cancel without charge. Late arrivals may shorten service time to respect the next guest.',
  },
  {
    key: 'retention_expectations',
    title: 'Individual results & retention',
    description:
      'I understand that lash lift, brow, and tint results vary by natural growth cycle, aftercare, and lifestyle. Retention and lift are not guaranteed to match reference photos or prior appointments.',
  },
  {
    key: 'post_care_compliance',
    title: 'Aftercare compliance',
    description:
      'I agree to follow all post-service instructions (including keeping lashes/brows dry, avoiding steam/saunas, and approved products) and understand that failure to do so may affect results and safety.',
  },
  {
    key: 'model_release_photos',
    title: 'Model release & photography',
    description:
      'I consent to before/after photography for studio portfolio, education, and marketing (including social media) unless I notify the studio in writing that I opt out.',
  },
];

export const EMPTY_MEDICAL_CONDITIONS: MedicalConditionsMap = {
  alopecia: false,
  eczema: false,
  trichotillomania: false,
  allergies: false,
  pregnant: false,
  sensitive_eyes: false,
  contact_lenses: false,
};

export const EMPTY_CONSENT_AGREEMENTS: ConsentAgreementsMap = {
  appointment_policies: false,
  retention_expectations: false,
  post_care_compliance: false,
  model_release_photos: false,
};

export const INITIAL_FORM: ConsentFormData = {
  full_name: '',
  phone: '',
  email: '',
  medical_conditions: { ...EMPTY_MEDICAL_CONDITIONS },
  medications: '',
  consent_agreements: { ...EMPTY_CONSENT_AGREEMENTS },
};

export function asMedicalConditions(value: unknown): MedicalConditionsMap {
  const base = { ...EMPTY_MEDICAL_CONDITIONS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const key of Object.keys(base) as MedicalConditionKey[]) {
    if (key in value) base[key] = Boolean((value as MedicalConditionsMap)[key]);
  }
  return base;
}

export function asConsentAgreements(value: unknown): ConsentAgreementsMap {
  const base = { ...EMPTY_CONSENT_AGREEMENTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const key of Object.keys(base) as ConsentAgreementKey[]) {
    if (key in value) base[key] = Boolean((value as ConsentAgreementsMap)[key]);
  }
  return base;
}

export function allAgreementsAccepted(agreements: ConsentAgreementsMap): boolean {
  return (Object.values(agreements) as boolean[]).every(Boolean);
}

export function buildInitialForm(client: ConsentApiResponse['client']): ConsentFormData {
  return {
    ...INITIAL_FORM,
    full_name: [client.first_name, client.last_name].filter(Boolean).join(' '),
    phone: client.phone ?? '',
    email: client.email ?? '',
    medical_conditions: { ...EMPTY_MEDICAL_CONDITIONS },
    consent_agreements: { ...EMPTY_CONSENT_AGREEMENTS },
  };
}
