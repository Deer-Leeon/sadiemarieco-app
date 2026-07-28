/**
 * Match dashboard appointments to a CRM client for live no-show-flag updates.
 */
import {
  clientPhoneLookupVariants,
  normaliseClientPhone,
} from '@/lib/client-identity';

import type { Appointment, Client } from '@/app/admin/types';

function appointmentPhoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return normaliseClientPhone(phone);
}

function phonesOverlap(
  appointmentPhone: string | null,
  clientPhone: string | null
): boolean {
  if (!appointmentPhone || !clientPhone) return false;
  const apt = appointmentPhoneDigits(appointmentPhone);
  const clientDigits = normaliseClientPhone(clientPhone);
  if (!apt || !clientDigits) return false;
  const variants = new Set(clientPhoneLookupVariants(clientDigits));
  variants.add(clientDigits);
  return variants.has(apt) || clientPhoneLookupVariants(apt).some((v) => variants.has(v));
}

function emailsMatch(
  appointmentEmail: string | null | undefined,
  clientEmail: string | null | undefined
): boolean {
  const a = (appointmentEmail || '').trim().toLowerCase();
  const c = (clientEmail || '').trim().toLowerCase();
  if (!a || !c) return false;
  return a === c;
}

/** True when this appointment row belongs to the given CRM client. */
export function appointmentBelongsToClient(
  appointment: Appointment,
  client: Pick<Client, 'phone' | 'email'>
): boolean {
  return (
    phonesOverlap(appointment.client_phone, client.phone) ||
    emailsMatch(appointment.client_email, client.email)
  );
}

/** Patch `client_no_show_flag` on every matching appointment (immutable). */
export function withClientNoShowFlag(
  appointments: Appointment[],
  client: Pick<Client, 'phone' | 'email'>,
  flag: boolean
): Appointment[] {
  return appointments.map((a) =>
    appointmentBelongsToClient(a, client)
      ? { ...a, client_no_show_flag: flag }
      : a
  );
}
