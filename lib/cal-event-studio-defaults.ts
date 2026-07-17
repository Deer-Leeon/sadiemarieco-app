import {
  CAL_CONFIRMATION_POLICY_DISABLED,
  CAL_STUDIO_IN_PERSON_LOCATION,
} from '@/lib/cal-config';

/**
 * Standard Cal.com booking fields for every public service event.
 * Applied via PATCH on create/update and by the backfill script.
 *
 * SMS consent sits immediately after the required phone field so carriers
 * see opt-in at the same step the number is collected.
 *
 * Keep the Cal label short — the embed auto-linkifies URLs in loud blue
 * and we can't restyle inside the iframe. Full disclosure + Privacy/Terms
 * links live in the booking drawer chrome (`public/index.html`).
 */
export const STUDIO_SMS_CONSENT_LABEL =
  'I agree to receive appointment texts from Sadie Marie (confirmations, reminders, and follow-ups). Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Consent is not required to book.';

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
    required: true,
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
