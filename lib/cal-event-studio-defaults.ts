import {
  CAL_CONFIRMATION_POLICY_DISABLED,
  CAL_STUDIO_IN_PERSON_LOCATION,
} from '@/lib/cal-config';

/** Merge attendee email suppression into existing Cal event-type metadata. */
export function buildCalEventMetadataWithAttendeeEmailsDisabled(
  existing: unknown
): Record<string, unknown> {
  const base = isRecord(existing) ? { ...existing } : {};
  const prev = isRecord(base.disableStandardEmails)
    ? (base.disableStandardEmails as Record<string, unknown>)
    : {};
  const prevConfirmation = isRecord(prev.confirmation)
    ? (prev.confirmation as Record<string, unknown>)
    : {};
  const prevScheduled = isRecord(prev.scheduled)
    ? (prev.scheduled as Record<string, unknown>)
    : {};
  const prevAll = isRecord(prev.all) ? (prev.all as Record<string, unknown>) : {};

  base.disableStandardEmails = {
    ...prev,
    confirmation: { ...prevConfirmation, attendee: true },
    scheduled: { ...prevScheduled, attendee: true },
    all: { ...prevAll, attendee: true },
  };

  return base;
}

export interface StudioCalEventPatchInput {
  bookingFields: unknown;
  existingMetadata?: unknown;
}

/** Body for PATCH /v2/event-types/:id — studio policy defaults. */
export function buildStudioCalEventPatchBody(
  input: StudioCalEventPatchInput
): Record<string, unknown> {
  return {
    bookingFields: input.bookingFields,
    confirmationPolicy: CAL_CONFIRMATION_POLICY_DISABLED,
    locations: [CAL_STUDIO_IN_PERSON_LOCATION],
    metadata: buildCalEventMetadataWithAttendeeEmailsDisabled(
      input.existingMetadata
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
