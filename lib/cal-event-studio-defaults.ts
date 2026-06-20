import {
  CAL_CONFIRMATION_POLICY_DISABLED,
  CAL_STUDIO_IN_PERSON_LOCATION,
} from '@/lib/cal-config';

/** Body for PATCH /v2/event-types/:id — studio policy defaults. */
export function buildStudioCalEventPatchBody(bookingFields: unknown): Record<string, unknown> {
  return {
    bookingFields,
    confirmationPolicy: CAL_CONFIRMATION_POLICY_DISABLED,
    locations: [CAL_STUDIO_IN_PERSON_LOCATION],
  };
}
