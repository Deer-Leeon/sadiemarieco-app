import {
  CAL_CONFIRMATION_POLICY_DISABLED,
  CAL_STUDIO_IN_PERSON_LOCATION,
} from '@/lib/cal-config';

/**
 * Standard Cal.com booking fields for every public service event.
 * Applied via PATCH on create/update and by the backfill script.
 *
 * Email is optional + visible. SMS consent stays optional (required: false)
 * for A2P 10DLC — clients must still provide email OR opt in to texts
 * (enforced in `public/js/main.js` + `/api/booking/init`).
 */
export const STUDIO_EMAIL_LABEL =
  'Email (optional if you opt in to appointment texts below)';

export const STUDIO_SMS_CONSENT_LABEL =
  'Yes, I agree to receive appointment texts from Sadie Marie (confirmations, reminders, and follow-ups). Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent to texts is not required to book if you provide an email above.\nPrivacy: https://sadiemarie.co/privacy\nTerms: https://sadiemarie.co/terms';

export const STUDIO_BOOKING_FIELDS = [
  {
    type: 'splitName' as const,
    firstNameLabel: 'First name',
    firstNamePlaceholder: 'First name',
    lastNameLabel: 'Last name',
    lastNamePlaceholder: 'Last name',
    lastNameRequired: true,
  },
  {
    type: 'email' as const,
    label: STUDIO_EMAIL_LABEL,
    placeholder: 'you@example.com',
    required: false,
    hidden: false,
  },
  {
    type: 'phone' as const,
    slug: 'attendeePhoneNumber',
    label: 'Phone number',
    required: true,
    placeholder: '+1 555 123 4567',
    hidden: false,
  },
  {
    type: 'boolean' as const,
    slug: 'sms-consent',
    label: STUDIO_SMS_CONSENT_LABEL,
    required: false,
  },
];

/** Body for PATCH /v2/event-types/:id — studio policy defaults. */
export function buildStudioCalEventPatchBody(
  bookingFields: unknown = STUDIO_BOOKING_FIELDS
): Record<string, unknown> {
  return {
    bookingFields,
    confirmationPolicy: CAL_CONFIRMATION_POLICY_DISABLED,
    locations: [CAL_STUDIO_IN_PERSON_LOCATION],
  };
}
