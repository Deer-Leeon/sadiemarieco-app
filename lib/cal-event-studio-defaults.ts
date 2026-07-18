import {
  CAL_CONFIRMATION_POLICY_DISABLED,
  CAL_STUDIO_IN_PERSON_LOCATION,
} from '@/lib/cal-config';

/**
 * Standard Cal.com booking fields for every public service event.
 * Applied via PATCH on create/update and by the backfill script.
 *
 * SMS consent sits immediately after the required phone field.
 * It must remain optional (required: false) — A2P 10DLC rejects
 * forced consent as a condition of completing a booking.
 */
export const STUDIO_SMS_CONSENT_LABEL =
  'Yes, I agree to receive appointment texts from Sadie Marie (confirmations, reminders, and follow-ups). Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not required to book. Privacy: https://sadiemarie.co/privacy · Terms: https://sadiemarie.co/terms';

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
